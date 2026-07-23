"""
Syphir Shield — packet_inspector.py
Counts actual bytes flowing per IP per domain in real time.
DNS tells us WHERE — packet inspector tells us HOW MUCH.

Two modes:
  Pi mode  — raw socket packet capture (requires root)
  Sim mode — generates realistic byte flow paired with DNS events
"""

import json
import time
import socket
import struct
import threading
import logging
import random
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

log = logging.getLogger('syphir.packet')

BASE_DIR = Path(__file__).parent


# ── IP header parser ──────────────────────────────────────────────────────────

def parse_ip_header(data):
    """
    Parse raw IP packet header.
    Returns (src_ip, dst_ip, protocol, payload_length) or None.
    """
    try:
        if len(data) < 20:
            return None
        ihl     = (data[0] & 0x0F) * 4   # IP header length
        proto   = data[9]                  # Protocol (6=TCP, 17=UDP)
        src_ip  = socket.inet_ntoa(data[12:16])
        dst_ip  = socket.inet_ntoa(data[16:20])
        total_len = struct.unpack('!H', data[2:4])[0]
        payload_len = total_len - ihl
        return src_ip, dst_ip, proto, max(payload_len, 0)
    except Exception:
        return None


def parse_tcp_header(data, ihl):
    """Extract TCP destination port from packet."""
    try:
        tcp_offset = ihl
        if len(data) < tcp_offset + 4:
            return None
        dst_port = struct.unpack('!H', data[tcp_offset + 2:tcp_offset + 4])[0]
        return dst_port
    except Exception:
        return None


# ── Flow tracker ──────────────────────────────────────────────────────────────

class FlowTracker:
    """
    Tracks byte counts per source IP per destination.
    Pairs with DNS data to map destinations to domain names.
    Window-based: resets flows after inactivity.
    """

    def __init__(self, window_minutes=10):
        self._window  = timedelta(minutes=window_minutes)
        self._flows   = defaultdict(lambda: {
            'bytes_out':  0,
            'bytes_in':   0,
            'packets':    0,
            'first_seen': None,
            'last_seen':  None,
        })
        # ip -> domain mapping built from DNS events
        self._dns_map = {}
        self._lock    = threading.Lock()

    def record_dns(self, ip, domain):
        """Called by dns_monitor when a device queries a domain."""
        with self._lock:
            self._dns_map[ip] = domain

    def record_packet(self, src_ip, dst_ip, bytes_count, direction='out'):
        """Record a packet flow."""
        with self._lock:
            now = datetime.utcnow()
            key = (src_ip, dst_ip)
            f   = self._flows[key]

            # Reset if window expired
            if f['last_seen'] and (now - f['last_seen']) > self._window:
                self._flows[key] = {
                    'bytes_out':  0, 'bytes_in': 0,
                    'packets':    0,
                    'first_seen': None, 'last_seen': None,
                }
                f = self._flows[key]

            if direction == 'out':
                f['bytes_out'] += bytes_count
            else:
                f['bytes_in']  += bytes_count

            f['packets']   += 1
            f['last_seen']  = now
            if not f['first_seen']:
                f['first_seen'] = now

    def get_flow(self, src_ip, dst_ip):
        """Get current flow stats for an IP pair."""
        with self._lock:
            return self._flows.get((src_ip, dst_ip), {}).copy()

    def get_domain_for_ip(self, ip):
        """Get the last domain queried by an IP."""
        with self._lock:
            return self._dns_map.get(ip)

    def get_top_flows(self, n=10):
        """Return top N flows by outbound bytes."""
        with self._lock:
            sorted_flows = sorted(
                self._flows.items(),
                key=lambda x: x[1]['bytes_out'],
                reverse=True
            )
            return sorted_flows[:n]

    def cleanup_expired(self):
        """Remove flows that have been idle longer than 3x the window."""
        with self._lock:
            now      = datetime.utcnow()
            cutoff   = self._window * 3
            expired  = [
                k for k, v in self._flows.items()
                if v['last_seen'] and (now - v['last_seen']) > cutoff
            ]
            for k in expired:
                del self._flows[k]
            if expired:
                log.debug(f"Cleaned up {len(expired)} expired flows")


# ── Real packet capture (Pi hardware) ────────────────────────────────────────

class RealPacketCapture:
    """
    Raw socket packet capture.
    Requires root / CAP_NET_RAW on Linux (Pi).
    On Mac: uses BPF — also requires root.

    Counts actual bytes for every TCP/UDP packet on the network interface.
    """

    def __init__(self, flow_tracker, interface=None):
        self.tracker   = flow_tracker
        self.interface = interface
        self._running  = False
        self._sock     = None
        self._stats    = {'packets': 0, 'bytes': 0, 'errors': 0}

    def start(self):
        try:
            import platform
            system = platform.system()

            if system == 'Linux':
                # Raw socket on Linux — captures all IP packets
                self._sock = socket.socket(
                    socket.AF_PACKET,
                    socket.SOCK_RAW,
                    socket.htons(0x0800)  # ETH_P_IP
                )
                if self.interface:
                    self._sock.bind((self.interface, 0))

            elif system == 'Darwin':
                # macOS raw socket — limited without root
                self._sock = socket.socket(
                    socket.AF_INET,
                    socket.SOCK_RAW,
                    socket.IPPROTO_TCP
                )
                self._sock.setsockopt(socket.IPPROTO_IP, socket.IP_HDRINCL, 1)

            else:
                log.error(f"Packet capture not supported on {system}")
                return False

            self._sock.settimeout(1.0)
            self._running = True
            threading.Thread(target=self._capture, daemon=True, name='packet-capture').start()
            log.info("Packet capture started (live mode)")
            return True

        except PermissionError:
            log.error("Packet capture requires root. Run: sudo python3 server.py")
            return False
        except Exception as e:
            log.error(f"Packet capture failed to start: {e}")
            return False

    def stop(self):
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
        log.info(
            f"Packet capture stopped — "
            f"{self._stats['packets']} packets, "
            f"{self._stats['bytes']/1024/1024:.1f}MB captured"
        )

    def _capture(self):
        log.info("Packet capture loop active")
        while self._running:
            try:
                data, addr = self._sock.recvfrom(65535)
                self._stats['packets'] += 1

                parsed = parse_ip_header(data)
                if not parsed:
                    continue

                src_ip, dst_ip, proto, payload_len = parsed
                self._stats['bytes'] += payload_len

                # Skip loopback
                if src_ip.startswith('127.') or dst_ip.startswith('127.'):
                    continue

                # Record outbound (LAN -> WAN) and inbound (WAN -> LAN)
                is_lan_src = self._is_local(src_ip)
                is_lan_dst = self._is_local(dst_ip)

                if is_lan_src and not is_lan_dst:
                    # Outbound — device sending data to internet
                    self.tracker.record_packet(src_ip, dst_ip, payload_len, 'out')
                elif not is_lan_src and is_lan_dst:
                    # Inbound — data coming back to device
                    self.tracker.record_packet(dst_ip, src_ip, payload_len, 'in')

            except socket.timeout:
                continue
            except Exception as e:
                self._stats['errors'] += 1
                if self._running:
                    log.debug(f"Capture error: {e}")

    def _is_local(self, ip):
        """Check if IP is in a private LAN range."""
        return (
            ip.startswith('192.168.') or
            ip.startswith('10.')       or
            ip.startswith('172.16.')   or
            ip.startswith('172.17.')   or
            ip.startswith('172.18.')   or
            ip.startswith('172.19.')   or
            ip.startswith('172.2')     or
            ip.startswith('172.3')
        )

    def get_stats(self):
        return self._stats.copy()


# ── Simulated packet flow (Mac testing) ──────────────────────────────────────

class SimPacketFlow:
    """
    Generates realistic packet flow data for testing.
    Paired with SimDNSListener — uses same employee IPs and domains.
    Simulates burst patterns (normal chat vs document dump vs file upload).
    """

    # Realistic traffic profiles per domain category
    PROFILES = {
        'ai': {
            'packet_size_range': (200, 8000),
            'burst_probability': 0.12,     # 12% chance of a large burst
            'burst_multiplier':  (5, 25),  # burst = 5-25x normal
            'interval_range':    (0.3, 2.0),
        },
        'storage': {
            'packet_size_range': (1000, 32000),
            'burst_probability': 0.25,
            'burst_multiplier':  (10, 50),
            'interval_range':    (0.5, 4.0),
        },
        'email': {
            'packet_size_range': (500, 15000),
            'burst_probability': 0.08,
            'burst_multiplier':  (3, 15),
            'interval_range':    (1.0, 5.0),
        },
        'normal': {
            'packet_size_range': (200, 5000),
            'burst_probability': 0.05,
            'burst_multiplier':  (2, 8),
            'interval_range':    (0.5, 3.0),
        },
        'suspicious': {
            'packet_size_range': (500, 50000),
            'burst_probability': 0.30,
            'burst_multiplier':  (10, 100),
            'interval_range':    (0.2, 1.0),
        },
    }

    DOMAIN_CATEGORIES = {
        'claude.ai':             'ai',
        'chat.openai.com':       'ai',
        'gemini.google.com':     'ai',
        'copilot.microsoft.com': 'ai',
        'chat.deepseek.com':     'ai',
        'perplexity.ai':         'ai',
        'dropbox.com':           'storage',
        'drive.google.com':      'storage',
        'onedrive.live.com':     'storage',
        'wetransfer.com':        'storage',
        'mail.google.com':       'email',
        'outlook.live.com':      'email',
        'mail.yahoo.com':        'email',
        'pastebin.com':          'suspicious',
        'temp-mail.org':         'suspicious',
    }

    def __init__(self, flow_tracker, callback):
        self.tracker   = flow_tracker
        self.callback  = callback
        self._running  = False

    def start(self):
        self._running = True
        threading.Thread(target=self._generate, daemon=True, name='sim-packets').start()
        log.info("Packet flow simulator started")

    def stop(self):
        self._running = False

    def _generate(self):
        """Generate continuous packet flow events."""
        employees = [
            {'ip': '192.168.1.42', 'name': 'John'},
            {'ip': '192.168.1.55', 'name': 'Sarah'},
            {'ip': '192.168.1.63', 'name': 'Mike'},
            {'ip': '192.168.1.71', 'name': 'Lisa'},
        ]
        domains = list(self.DOMAIN_CATEGORIES.keys())

        while self._running:
            employee = random.choice(employees)
            domain   = random.choice(domains)
            category = self.DOMAIN_CATEGORIES.get(domain, 'normal')
            profile  = self.PROFILES.get(category, self.PROFILES['normal'])

            lo, hi     = profile['packet_size_range']
            base_bytes = random.randint(lo, hi)

            # Simulate burst events
            if random.random() < profile['burst_probability']:
                mult       = random.uniform(*profile['burst_multiplier'])
                bytes_sent = int(base_bytes * mult)
                is_burst   = True
            else:
                bytes_sent = base_bytes
                is_burst   = False

            # Record in flow tracker
            dst_ip = f"52.{random.randint(1,254)}.{random.randint(1,254)}.{random.randint(1,254)}"
            self.tracker.record_packet(employee['ip'], dst_ip, bytes_sent, 'out')
            self.tracker.record_dns(employee['ip'], domain)

            event = {
                'type':      'packet',
                'src_ip':    employee['ip'],
                'dst_ip':    dst_ip,
                'domain':    domain,
                'category':  category,
                'bytes':     bytes_sent,
                'is_burst':  is_burst,
                'employee':  employee['name'],
                'timestamp': datetime.utcnow().isoformat(),
            }

            if is_burst:
                log.debug(
                    f"BURST | {employee['name']} -> {domain} | "
                    f"{bytes_sent/1024:.1f}KB [{category}]"
                )

            self.callback(event)

            lo_i, hi_i = profile['interval_range']
            time.sleep(random.uniform(lo_i, hi_i))


# ── PacketInspector — public interface ────────────────────────────────────────

class PacketInspector:
    """
    Main packet inspection class used by server.py.
    Combines FlowTracker with Real or Sim capture.
    """

    def __init__(self, config, on_event=None):
        self.config    = config
        self.on_event  = on_event or (lambda e: None)
        self._sim_mode = config.get('simulation_mode', True)
        self.tracker   = FlowTracker(
            window_minutes=config.get('session_window_minutes', 10)
        )
        self._capture  = None
        self._cleanup_thread = None

    def start(self):
        if self._sim_mode:
            self._capture = SimPacketFlow(
                flow_tracker=self.tracker,
                callback=self.on_event
            )
            log.info("Packet inspector starting in simulation mode")
        else:
            self._capture = RealPacketCapture(
                flow_tracker=self.tracker,
                interface=self.config.get('network_interface')
            )
            log.info("Packet inspector starting in live mode")

        self._capture.start()

        # Cleanup thread
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop, daemon=True, name='flow-cleanup'
        )
        self._cleanup_thread.start()

    def stop(self):
        if self._capture:
            self._capture.stop()

    def record_dns(self, ip, domain):
        """Called by DNSMonitor to keep IP->domain mapping fresh."""
        self.tracker.record_dns(ip, domain)

    def get_flow_bytes(self, src_ip, dst_ip):
        """Get current outbound byte count for an IP pair."""
        flow = self.tracker.get_flow(src_ip, dst_ip)
        return flow.get('bytes_out', 0)

    def get_session_bytes(self, ip, domain):
        """
        Get total bytes sent from an IP to a domain across all connections.
        Used by DecisionEngine for threshold checks.
        """
        total = 0
        with self.tracker._lock:
            for (src, dst), flow in self.tracker._flows.items():
                if src == ip:
                    mapped_domain = self.tracker._dns_map.get(src)
                    if mapped_domain and domain in mapped_domain:
                        total += flow.get('bytes_out', 0)
        return total

    def get_top_talkers(self, n=5):
        """Return top N IPs by total outbound bytes — useful for dashboard."""
        flows = self.tracker.get_top_flows(n)
        result = []
        for (src, dst), stats in flows:
            domain = self.tracker.get_domain_for_ip(src)
            result.append({
                'ip':        src,
                'domain':    domain or dst,
                'bytes_out': stats['bytes_out'],
                'bytes_in':  stats['bytes_in'],
                'packets':   stats['packets'],
            })
        return result

    def _cleanup_loop(self):
        """Periodically clean up expired flows."""
        while True:
            time.sleep(300)  # every 5 minutes
            self.tracker.cleanup_expired()


# ── Standalone test ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    config = {'simulation_mode': True, 'session_window_minutes': 10}
    events = []

    def on_packet(event):
        events.append(event)
        if event.get('is_burst'):
            kb  = event['bytes'] / 1024
            cat = event['category']
            emp = event['employee']
            dom = event['domain']
            color = '\033[91m' if cat in ('ai','suspicious') else '\033[93m'
            reset = '\033[0m'
            print(f"{color}BURST{reset} | {emp:<6} -> {dom:<35} {kb:>8.1f}KB [{cat}]")

    inspector = PacketInspector(config, on_event=on_packet)
    inspector.start()

    print("\nSyphir Packet Inspector — watching simulated network traffic")
    print("Only showing burst events (threshold-triggering packets)")
    print("Ctrl+C to stop\n")

    try:
        while True:
            time.sleep(15)
            top = inspector.get_top_talkers(5)
            print("\n--- Top 5 talkers ---")
            for t in top:
                print(
                    f"  {t['ip']:<16} -> {t['domain']:<35} "
                    f"out={t['bytes_out']/1024:>7.1f}KB  "
                    f"pkts={t['packets']}"
                )
            print()
    except KeyboardInterrupt:
        inspector.stop()
        print(f"\nStopped. {len(events)} packet events recorded.")