"""
Syphir Shield — intrusion_detector.py
Layer 1: Detects active attacks and intrusions in real time.
Watches for port scans, brute force, C2 beaconing, lateral movement,
DNS tunneling, reverse shells, and known bad IPs.
Calls blocker.py when a threat is confirmed.
"""

import json
import time
import logging
import threading
import ipaddress
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

log = logging.getLogger('syphir.intrusion')

BASE_DIR = Path(__file__).parent


def load_threat_intel():
    path = BASE_DIR / 'threat_intel.json'
    if not path.exists():
        log.error("threat_intel.json not found")
        return {}
    with open(path) as f:
        return json.load(f)


# ── Connection tracker ────────────────────────────────────────────────────────

class ConnectionTracker:
    """
    Tracks connection patterns per source IP.
    Used to detect scans, brute force, beaconing, lateral movement.
    """

    def __init__(self, window_seconds=60):
        self._window   = window_seconds
        self._data     = defaultdict(lambda: {
            'connections':   [],    # list of (timestamp, dst_ip, dst_port)
            'dns_queries':   [],    # list of (timestamp, domain, length)
            'bytes_out':     [],    # list of (timestamp, bytes)
            'first_seen':    None,
            'last_seen':     None,
        })
        self._lock = threading.Lock()

    def record_connection(self, src_ip, dst_ip, dst_port, bytes_out=0):
        with self._lock:
            now = datetime.utcnow()
            d   = self._data[src_ip]
            d['connections'].append((now, dst_ip, dst_port))
            if bytes_out:
                d['bytes_out'].append((now, bytes_out))
            d['last_seen'] = now
            if not d['first_seen']:
                d['first_seen'] = now
            self._prune(d, now)

    def record_dns(self, src_ip, domain):
        with self._lock:
            now = datetime.utcnow()
            d   = self._data[src_ip]
            d['dns_queries'].append((now, domain, len(domain)))
            d['last_seen'] = now
            if not d['first_seen']:
                d['first_seen'] = now
            self._prune(d, now)

    def get_recent_connections(self, src_ip, seconds=60):
        with self._lock:
            now    = datetime.utcnow()
            cutoff = now - timedelta(seconds=seconds)
            return [(ts, dst, port) for ts, dst, port in self._data[src_ip]['connections'] if ts > cutoff]

    def get_recent_dns(self, src_ip, seconds=60):
        with self._lock:
            now    = datetime.utcnow()
            cutoff = now - timedelta(seconds=seconds)
            return [(ts, dom, ln) for ts, dom, ln in self._data[src_ip]['dns_queries'] if ts > cutoff]

    def get_recent_bytes(self, src_ip, seconds=60):
        with self._lock:
            now    = datetime.utcnow()
            cutoff = now - timedelta(seconds=seconds)
            return sum(b for ts, b in self._data[src_ip]['bytes_out'] if ts > cutoff)

    def get_all_ips(self):
        with self._lock:
            return list(self._data.keys())

    def _prune(self, d, now):
        cutoff = now - timedelta(seconds=self._window * 3)
        d['connections'] = [(ts, dst, p) for ts, dst, p in d['connections'] if ts > cutoff]
        d['dns_queries'] = [(ts, dom, ln) for ts, dom, ln in d['dns_queries'] if ts > cutoff]
        d['bytes_out']   = [(ts, b) for ts, b in d['bytes_out'] if ts > cutoff]


# ── Beacon detector ───────────────────────────────────────────────────────────

class BeaconDetector:
    """
    Detects C2 beaconing — connections to the same destination
    at suspiciously regular intervals.
    """

    def __init__(self, min_occurrences=6, variance_seconds=5):
        self._min_occ  = min_occurrences
        self._variance = variance_seconds
        self._history  = defaultdict(list)  # (src, dst) -> [timestamps]
        self._lock     = threading.Lock()

    def record(self, src_ip, dst_ip, timestamp=None):
        key = (src_ip, dst_ip)
        ts  = timestamp or datetime.utcnow()
        with self._lock:
            self._history[key].append(ts)
            # Keep only last 20 entries
            self._history[key] = self._history[key][-20:]

    def check_beacon(self, src_ip, dst_ip):
        key = (src_ip, dst_ip)
        with self._lock:
            times = self._history.get(key, [])
        if len(times) < self._min_occ:
            return False, 0

        # Calculate intervals between connections
        intervals = []
        for i in range(1, len(times)):
            delta = (times[i] - times[i-1]).total_seconds()
            intervals.append(delta)

        if not intervals:
            return False, 0

        avg_interval = sum(intervals) / len(intervals)
        variance     = sum(abs(iv - avg_interval) for iv in intervals) / len(intervals)

        # Low variance = regular beaconing
        if variance <= self._variance and avg_interval > 0:
            return True, round(avg_interval)

        return False, 0


# ── Known device tracker ──────────────────────────────────────────────────────

class DeviceRegistry:
    """
    Tracks known devices on the network.
    Alerts on new/unknown devices appearing.
    """

    REGISTRY_FILE = BASE_DIR / 'known_devices.json'

    def __init__(self):
        self._known = set()
        self._load()

    def _load(self):
        if self.REGISTRY_FILE.exists():
            try:
                with open(self.REGISTRY_FILE) as f:
                    data = json.load(f)
                    self._known = set(data.get('devices', []))
                log.info(f"Device registry loaded — {len(self._known)} known devices")
            except Exception as e:
                log.warning(f"Could not load device registry: {e}")

    def _save(self):
        try:
            with open(self.REGISTRY_FILE, 'w') as f:
                json.dump({'devices': list(self._known), 'updated': datetime.utcnow().isoformat()}, f, indent=2)
        except Exception as e:
            log.warning(f"Could not save device registry: {e}")

    def is_known(self, ip):
        return ip in self._known or self._is_local_infra(ip)

    def register(self, ip):
        if ip not in self._known:
            self._known.add(ip)
            self._save()
            log.info(f"New device registered: {ip}")

    def _is_local_infra(self, ip):
        """Skip flagging common local infrastructure IPs."""
        return ip in ('127.0.0.1', '::1', '0.0.0.0') or ip.endswith('.1') or ip.endswith('.254')


# ── Intrusion Detector ────────────────────────────────────────────────────────

class IntrusionDetector:
    """
    Main Layer 1 detection engine.
    Analyzes events from dns_monitor and packet_inspector.
    Fires alerts when attack signatures are matched.
    """

    def __init__(self, config, on_threat=None):
        self.config      = config
        self.on_threat   = on_threat or (lambda t, ctx=None: None)
        self._intel      = load_threat_intel()
        self._tracker    = ConnectionTracker()
        self._beacon     = BeaconDetector(
            min_occurrences=6,
            variance_seconds=5
        )
        self._registry   = DeviceRegistry()
        self._alerted    = set()      # (src_ip, signature_id) already alerted
        self._running    = False

        # Build fast lookup sets from threat intel
        self._bad_domains  = {d['domain']: d for d in self._intel.get('known_c2_domains', [])}
        self._whitelist_ips    = set(self._intel.get('whitelist_ips', []))
        self._whitelist_domains = set(self._intel.get('whitelist_domains', []))
        self._bad_ip_ranges    = self._parse_ip_ranges()

        log.info(
            f"Intrusion detector loaded — "
            f"{len(self._bad_domains)} C2 domains, "
            f"{len(self._bad_ip_ranges)} bad IP ranges, "
            f"{len(self._intel.get('attack_signatures', []))} signatures"
        )

    def _parse_ip_ranges(self):
        ranges = []
        for entry in self._intel.get('malicious_ip_ranges', []):
            try:
                ranges.append((ipaddress.ip_network(entry['range'], strict=False), entry))
            except Exception:
                pass
        return ranges

    def _is_bad_ip(self, ip):
        if ip in self._whitelist_ips:
            return None
        try:
            addr = ipaddress.ip_address(ip)
            for network, info in self._bad_ip_ranges:
                if addr in network:
                    return info
        except Exception:
            pass
        return None

    def _is_bad_domain(self, domain):
        if not domain:
            return None
        for known, info in self._bad_domains.items():
            if known in domain:
                return info
        return None

    def _already_alerted(self, src_ip, sig_id):
        key = (src_ip, sig_id)
        if key in self._alerted:
            return True
        self._alerted.add(key)
        # Clear after 30 min so we re-alert if attack continues
        threading.Timer(1800, lambda: self._alerted.discard(key)).start()
        return False

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self):
        self._running = True
        # Background cleanup thread
        threading.Thread(target=self._cleanup_loop, daemon=True, name='ids-cleanup').start()
        log.info("Intrusion detector started")

    def stop(self):
        self._running = False

    def on_dns_event(self, event):
        """Called for every DNS query."""
        src_ip = event.get('ip', '')
        domain = event.get('domain', '')
        if not src_ip or not domain:
            return

        # Register device
        if not self._registry.is_known(src_ip):
            self._fire_threat({
                'signature_id': 'AS011',
                'name':         'New device on network',
                'src_ip':       src_ip,
                'detail':       f"Unknown device {src_ip} appeared on network",
                'risk':         'medium',
                'response':     'alert',
            })
            self._registry.register(src_ip)

        # Check domain against threat intel
        bad = self._is_bad_domain(domain)
        if bad:
            if not self._already_alerted(src_ip, f"AS012_{domain}"):
                self._fire_threat({
                    'signature_id': 'AS012',
                    'name':         'Connection to known C2',
                    'src_ip':       src_ip,
                    'domain':       domain,
                    'detail':       f"{src_ip} connected to known C2 domain {domain} — {bad.get('label','')}",
                    'risk':         bad.get('risk', 'high'),
                    'response':     'isolate_and_alert',
                    'intel':        bad,
                })

        # DNS anomaly — tunneling detection
        self._tracker.record_dns(src_ip, domain)
        self._check_dns_tunneling(src_ip, domain)

    def on_packet_event(self, event):
        """Called for every significant packet flow."""
        src_ip  = event.get('src_ip', event.get('ip', ''))
        dst_ip  = event.get('dst_ip', '')
        dst_port = event.get('dst_port', 0)
        bytes_out = event.get('bytes', 0)

        if not src_ip:
            return

        # Check destination IP against threat intel
        bad_ip = self._is_bad_ip(dst_ip)
        if bad_ip:
            if not self._already_alerted(src_ip, f"bad_ip_{dst_ip}"):
                self._fire_threat({
                    'signature_id': 'AS012',
                    'name':         'Connection to malicious IP',
                    'src_ip':       src_ip,
                    'dst_ip':       dst_ip,
                    'detail':       f"{src_ip} connected to malicious IP {dst_ip} — {bad_ip.get('label','')}",
                    'risk':         bad_ip.get('risk', 'high'),
                    'response':     'block_and_alert',
                    'intel':        bad_ip,
                })

        # Record connection
        self._tracker.record_connection(src_ip, dst_ip, dst_port, bytes_out)

        # Update beacon detector
        if dst_ip:
            self._beacon.record(src_ip, dst_ip)

        # Run signature checks
        self._check_port_scan(src_ip)
        self._check_brute_force(src_ip, dst_port)
        self._check_lateral_movement(src_ip, dst_ip, dst_port)
        self._check_beacon(src_ip, dst_ip)
        self._check_reverse_shell(src_ip, dst_port)
        self._check_bulk_exfil(src_ip)

    # ── Signature checks ──────────────────────────────────────────────────────

    def _check_port_scan(self, src_ip):
        conns = self._tracker.get_recent_connections(src_ip, seconds=60)
        unique_dsts = len(set(dst for _, dst, _ in conns))
        unique_ports = len(set(port for _, _, port in conns))

        if unique_dsts >= 10 and not self._already_alerted(src_ip, 'AS001'):
            self._fire_threat({
                'signature_id': 'AS001',
                'name':         'Port scan — horizontal',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} scanned {unique_dsts} unique IPs in 60s",
                'risk':         'high',
                'response':     'block_and_alert',
            })

        if unique_ports >= 15 and not self._already_alerted(src_ip, 'AS002'):
            self._fire_threat({
                'signature_id': 'AS002',
                'name':         'Port scan — vertical',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} hit {unique_ports} unique ports in 60s",
                'risk':         'high',
                'response':     'block_and_alert',
            })

    def _check_brute_force(self, src_ip, dst_port):
        if dst_port not in (22, 3389):
            return
        conns  = self._tracker.get_recent_connections(src_ip, seconds=60)
        hits   = sum(1 for _, _, p in conns if p == dst_port)
        sig_id = 'AS003' if dst_port == 22 else 'AS004'
        proto  = 'SSH' if dst_port == 22 else 'RDP'
        if hits >= 5 and not self._already_alerted(src_ip, sig_id):
            self._fire_threat({
                'signature_id': sig_id,
                'name':         f'Brute force — {proto}',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} made {hits} {proto} attempts in 60s",
                'risk':         'critical',
                'response':     'block_and_alert',
            })

    def _check_lateral_movement(self, src_ip, dst_ip, dst_port):
        if dst_port != 22:
            return
        if not self._is_lan(src_ip) or not self._is_lan(dst_ip):
            return
        conns   = self._tracker.get_recent_connections(src_ip, seconds=300)
        targets = set(dst for _, dst, p in conns if p == 22 and self._is_lan(dst))
        if len(targets) >= 3 and not self._already_alerted(src_ip, 'AS005'):
            self._fire_threat({
                'signature_id': 'AS005',
                'name':         'Lateral movement — internal SSH',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} SSH'd to {len(targets)} internal machines: {', '.join(list(targets)[:5])}",
                'risk':         'critical',
                'response':     'isolate_and_alert',
            })

    def _check_beacon(self, src_ip, dst_ip):
        if not dst_ip or self._is_lan(dst_ip):
            return
        is_beacon, interval = self._beacon.check_beacon(src_ip, dst_ip)
        if is_beacon and not self._already_alerted(src_ip, f'AS006_{dst_ip}'):
            self._fire_threat({
                'signature_id': 'AS006',
                'name':         'C2 beacon detected',
                'src_ip':       src_ip,
                'dst_ip':       dst_ip,
                'detail':       f"{src_ip} beaconing to {dst_ip} every ~{interval}s — possible C2",
                'risk':         'critical',
                'response':     'isolate_and_alert',
            })

    def _check_dns_tunneling(self, src_ip, domain):
        recent_dns = self._tracker.get_recent_dns(src_ip, seconds=60)
        query_count = len(recent_dns)
        avg_len     = sum(ln for _, _, ln in recent_dns) / max(len(recent_dns), 1)
        if (query_count >= 60 or avg_len >= 50) and not self._already_alerted(src_ip, 'AS007'):
            self._fire_threat({
                'signature_id': 'AS007',
                'name':         'DNS tunneling detected',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} made {query_count} DNS queries in 60s (avg length {avg_len:.0f} chars)",
                'risk':         'high',
                'response':     'block_and_alert',
            })

    def _check_reverse_shell(self, src_ip, dst_port):
        if 4000 <= dst_port <= 9999 and not self._already_alerted(src_ip, f'AS008_{dst_port}'):
            self._fire_threat({
                'signature_id': 'AS008',
                'name':         'Possible reverse shell',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} connected to high port {dst_port} — possible reverse shell",
                'risk':         'critical',
                'response':     'isolate_and_alert',
            })

    def _check_bulk_exfil(self, src_ip):
        bytes_out = self._tracker.get_recent_bytes(src_ip, seconds=60)
        if bytes_out >= 5242880 and not self._already_alerted(src_ip, 'AS009'):
            self._fire_threat({
                'signature_id': 'AS009',
                'name':         'Bulk outbound data exfiltration',
                'src_ip':       src_ip,
                'detail':       f"{src_ip} sent {bytes_out/1024/1024:.1f}MB outbound in 60s",
                'risk':         'high',
                'response':     'alert',
            })

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _is_lan(self, ip):
        try:
            addr = ipaddress.ip_address(ip)
            return addr.is_private
        except Exception:
            return False

    def _fire_threat(self, threat):
        threat['timestamp'] = datetime.utcnow().isoformat()
        log.warning(
            f"THREAT [{threat['risk'].upper()}] {threat['name']} | "
            f"{threat.get('src_ip','')} | {threat['detail']}"
        )
        # Build context for confidence scorer
        context = {
            'domain':     threat.get('domain', ''),
            'bytes_sent': threat.get('bytes_sent', 0),
            'hour':       datetime.utcnow().hour,
            'src_ip':     threat.get('src_ip', ''),
        }
        self.on_threat(threat, context)

    def _cleanup_loop(self):
        while self._running:
            time.sleep(300)
            # Prune alerted set periodically handled by timers
            log.debug(f"IDS stats — {len(self._alerted)} active alert suppressions")


# Standalone test
if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s  [%(levelname)s]  %(message)s')

    config  = {'simulation_mode': True}
    threats = []

    def on_threat(t):
        threats.append(t)
        color = '\033[91m' if t['risk'] == 'critical' else '\033[93m'
        reset = '\033[0m'
        print(f"\n{color}THREAT DETECTED{reset}")
        print(f"  Signature : {t['signature_id']} — {t['name']}")
        print(f"  Source IP : {t.get('src_ip','?')}")
        print(f"  Risk      : {t['risk'].upper()}")
        print(f"  Response  : {t['response']}")
        print(f"  Detail    : {t['detail']}")
        print()

    detector = IntrusionDetector(config, on_threat=on_threat)
    detector.start()

    print("\nSyphir Intrusion Detector — running simulation\n")

    import random

    # Simulate port scan
    print("[SIM] Simulating horizontal port scan from 10.0.0.99...")
    for i in range(15):
        detector.on_packet_event({
            'src_ip': '10.0.0.99',
            'dst_ip': f'192.168.1.{i+10}',
            'dst_port': 80,
            'bytes': 100,
        })
    time.sleep(1)

    # Simulate SSH brute force
    print("[SIM] Simulating SSH brute force from 203.0.113.5...")
    for i in range(8):
        detector.on_packet_event({
            'src_ip': '203.0.113.5',
            'dst_ip': '192.168.1.42',
            'dst_port': 22,
            'bytes': 200,
        })
    time.sleep(1)

    # Simulate C2 domain hit
    print("[SIM] Simulating connection to ngrok C2 domain...")
    detector.on_dns_event({
        'ip': '192.168.1.42',
        'domain': 'ngrok.io',
        'bytes': 500,
    })
    time.sleep(1)

    # Simulate lateral movement
    print("[SIM] Simulating lateral movement via SSH...")
    for target in ['192.168.1.50', '192.168.1.51', '192.168.1.52', '192.168.1.53']:
        detector.on_packet_event({
            'src_ip': '192.168.1.42',
            'dst_ip': target,
            'dst_port': 22,
            'bytes': 300,
        })
    time.sleep(1)

    print(f"\nSimulation complete — {len(threats)} threats detected.")
    detector.stop()