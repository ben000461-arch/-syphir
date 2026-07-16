"""
Syphir Shield — dns_monitor.py
Listens to every DNS query on the network.
Every device asks "where is X?" before connecting — we see it first.

Two modes:
  Pi mode (simulation_mode: false) — reads real DNS queries via UDP socket
  Sim mode (simulation_mode: true)  — generates realistic traffic for testing
"""

import json
import time
import socket
import struct
import threading
import logging
import random
from datetime import datetime
from pathlib import Path
from collections import defaultdict

log = logging.getLogger('syphir.dns')

BASE_DIR = Path(__file__).parent

# DNS port
DNS_PORT = 53


# ── DNS packet parser ─────────────────────────────────────────────────────────

def parse_dns_query(data):
    """
    Parse a raw DNS UDP packet and extract the queried domain name.
    Returns domain string or None if parsing fails.
    """
    try:
        # Skip the 12-byte DNS header
        if len(data) < 12:
            return None

        offset = 12
        labels = []

        while offset < len(data):
            length = data[offset]
            if length == 0:
                break
            # Pointer (compression) — skip
            if length & 0xC0 == 0xC0:
                offset += 2
                break
            offset += 1
            if offset + length > len(data):
                break
            labels.append(data[offset:offset + length].decode('ascii', errors='ignore'))
            offset += length

        if not labels:
            return None

        return '.'.join(labels).lower()

    except Exception:
        return None


def parse_source_ip(addr):
    """Extract source IP from socket address tuple."""
    return addr[0] if addr else '0.0.0.0'


# ── Real DNS listener (Pi hardware) ──────────────────────────────────────────

class RealDNSListener:
    """
    Binds to UDP port 53 and reads every DNS query on the network.
    Requires the Pi to be the network's DNS server (via Pi-hole).
    Must run as root or with CAP_NET_BIND_SERVICE.
    """

    def __init__(self, callback, interface='0.0.0.0'):
        self.callback  = callback
        self.interface = interface
        self._running  = False
        self._sock     = None

    def start(self):
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._sock.bind((self.interface, DNS_PORT))
            self._sock.settimeout(1.0)
            self._running = True
            threading.Thread(target=self._listen, daemon=True, name='dns-listener').start()
            log.info(f"DNS listener bound to {self.interface}:{DNS_PORT}")
        except PermissionError:
            log.error("Cannot bind to port 53 — run with sudo or grant CAP_NET_BIND_SERVICE")
            raise
        except Exception as e:
            log.error(f"DNS listener failed to start: {e}")
            raise

    def stop(self):
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass

    def _listen(self):
        log.info("DNS listener active — watching network queries")
        while self._running:
            try:
                data, addr = self._sock.recvfrom(512)
                domain = parse_dns_query(data)
                if domain and not domain.endswith('.local') and '.' in domain:
                    ip = parse_source_ip(addr)
                    self.callback({
                        'domain':    domain,
                        'ip':        ip,
                        'timestamp': datetime.utcnow().isoformat(),
                        'bytes':     self._estimate_query_size(domain),
                        'source':    'dns',
                    })
            except socket.timeout:
                continue
            except Exception as e:
                if self._running:
                    log.debug(f"DNS recv error: {e}")

    def _estimate_query_size(self, domain):
        """
        We can't know payload size from DNS alone.
        This gets replaced by packet_inspector.py data when available.
        Conservative estimate: 1KB per query as baseline.
        """
        return 1024


# ── Simulation DNS listener (Mac testing) ────────────────────────────────────

class SimDNSListener:
    """
    Generates realistic DNS traffic patterns for testing without hardware.
    Simulates a real office network with multiple employees and AI tools.
    """

    # Realistic office browsing patterns
    EMPLOYEES = [
        {'ip': '192.168.1.42', 'name': 'John',  'role': 'paralegal'},
        {'ip': '192.168.1.55', 'name': 'Sarah', 'role': 'attorney'},
        {'ip': '192.168.1.63', 'name': 'Mike',  'role': 'admin'},
        {'ip': '192.168.1.71', 'name': 'Lisa',  'role': 'partner'},
    ]

    # Domain patterns with realistic byte estimates
    DOMAIN_PATTERNS = [
        # AI tools — monitored closely
        {'domain': 'claude.ai',            'weight': 15, 'bytes_range': (500,   45000), 'category': 'ai'},
        {'domain': 'chat.openai.com',      'weight': 20, 'bytes_range': (500,   60000), 'category': 'ai'},
        {'domain': 'gemini.google.com',    'weight': 8,  'bytes_range': (500,   30000), 'category': 'ai'},
        {'domain': 'copilot.microsoft.com','weight': 5,  'bytes_range': (500,   25000), 'category': 'ai'},
        {'domain': 'chat.deepseek.com',    'weight': 2,  'bytes_range': (1000,  50000), 'category': 'ai'},
        {'domain': 'perplexity.ai',        'weight': 4,  'bytes_range': (300,   8000),  'category': 'ai'},

        # Cloud storage — watch for large uploads
        {'domain': 'dropbox.com',          'weight': 10, 'bytes_range': (1000, 500000), 'category': 'storage'},
        {'domain': 'drive.google.com',     'weight': 12, 'bytes_range': (1000, 300000), 'category': 'storage'},
        {'domain': 'onedrive.live.com',    'weight': 6,  'bytes_range': (1000, 400000), 'category': 'storage'},
        {'domain': 'wetransfer.com',       'weight': 3,  'bytes_range': (5000, 800000), 'category': 'storage'},

        # Personal email — flag if heavy usage during work hours
        {'domain': 'mail.google.com',      'weight': 18, 'bytes_range': (500,   50000), 'category': 'email'},
        {'domain': 'outlook.live.com',     'weight': 8,  'bytes_range': (500,   40000), 'category': 'email'},
        {'domain': 'mail.yahoo.com',       'weight': 3,  'bytes_range': (500,   20000), 'category': 'email'},

        # Normal work domains — low risk
        {'domain': 'google.com',           'weight': 30, 'bytes_range': (200,   5000),  'category': 'normal'},
        {'domain': 'microsoft.com',        'weight': 15, 'bytes_range': (200,   8000),  'category': 'normal'},
        {'domain': 'zoom.us',              'weight': 12, 'bytes_range': (1000,  50000), 'category': 'normal'},
        {'domain': 'slack.com',            'weight': 20, 'bytes_range': (500,   30000), 'category': 'normal'},
        {'domain': 'github.com',           'weight': 8,  'bytes_range': (500,   20000), 'category': 'normal'},

        # Data broker / suspicious
        {'domain': 'pastebin.com',         'weight': 1,  'bytes_range': (1000, 100000), 'category': 'suspicious'},
        {'domain': 'temp-mail.org',        'weight': 1,  'bytes_range': (500,   5000),  'category': 'suspicious'},
    ]

    def __init__(self, callback):
        self.callback  = callback
        self._running  = False
        # Track session bytes per employee per domain for realism
        self._sessions = defaultdict(lambda: defaultdict(int))

    def start(self):
        self._running = True
        threading.Thread(target=self._generate, daemon=True, name='sim-dns').start()
        log.info("DNS listener started (simulation mode)")

    def stop(self):
        self._running = False

    def _generate(self):
        """Generate realistic DNS query stream."""
        while self._running:
            # Pick a random employee
            employee = random.choice(self.EMPLOYEES)
            # Pick a domain weighted by frequency
            pattern  = self._weighted_choice(self.DOMAIN_PATTERNS)
            domain   = pattern['domain']

            # Generate realistic byte count
            lo, hi   = pattern['bytes_range']
            # Occasional large bursts (document pastes, file uploads)
            if random.random() < 0.08:
                bytes_sent = random.randint(hi // 2, hi)
            else:
                bytes_sent = random.randint(lo, lo + (hi - lo) // 4)

            self._sessions[employee['ip']][domain] += bytes_sent

            event = {
                'domain':       domain,
                'ip':           employee['ip'],
                'employee_name': employee['name'],
                'category':     pattern['category'],
                'timestamp':    datetime.utcnow().isoformat(),
                'bytes':        bytes_sent,
                'session_bytes': self._sessions[employee['ip']][domain],
                'source':       'dns_sim',
            }

            self.callback(event)

            # Realistic query rate: 0.5 - 3 seconds between queries
            time.sleep(random.uniform(0.5, 3.0))

    def _weighted_choice(self, patterns):
        total  = sum(p['weight'] for p in patterns)
        r      = random.uniform(0, total)
        running = 0
        for p in patterns:
            running += p['weight']
            if r <= running:
                return p
        return patterns[-1]


# ── DNS Monitor — public interface ────────────────────────────────────────────

class DNSMonitor:
    """
    Main DNS monitoring class used by server.py.
    Automatically picks Real or Sim listener based on config.
    """

    def __init__(self, config, on_event):
        """
        config    : loaded config.json dict
        on_event  : callback(event_dict) called for every DNS query
        """
        self.config     = config
        self.on_event   = on_event
        self._listener  = None
        self._sim_mode  = config.get('simulation_mode', True)
        self._stats     = {
            'total_queries': 0,
            'ai_queries':    0,
            'flagged':       0,
            'started_at':    None,
        }

    def start(self):
        self._stats['started_at'] = datetime.utcnow().isoformat()

        if self._sim_mode:
            self._listener = SimDNSListener(callback=self._handle_event)
            log.info("DNS monitor starting in simulation mode")
        else:
            interface = self.config.get('listen_interface', '0.0.0.0')
            self._listener = RealDNSListener(callback=self._handle_event, interface=interface)
            log.info("DNS monitor starting in live mode")

        self._listener.start()

    def stop(self):
        if self._listener:
            self._listener.stop()
        log.info(f"DNS monitor stopped — {self._stats['total_queries']} total queries seen")

    def get_stats(self):
        return self._stats.copy()

    def _handle_event(self, event):
        """Internal handler — updates stats then passes to server.py callback."""
        self._stats['total_queries'] += 1

        category = event.get('category', '')
        if category == 'ai':
            self._stats['ai_queries'] += 1

        log.debug(
            f"DNS | {event['ip']} -> {event['domain']} | "
            f"{event['bytes']/1024:.1f}KB | cat={category}"
        )

        # Pass to server.py decision engine
        self.on_event(event)


# ── Standalone test ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    config = {'simulation_mode': True}
    seen   = []

    def on_event(event):
        seen.append(event)
        cat   = event.get('category', '?')
        color = '\033[91m' if cat == 'ai' else '\033[93m' if cat == 'suspicious' else '\033[90m'
        reset = '\033[0m'
        print(
            f"{color}[{cat.upper():<10}]{reset} "
            f"{event['ip']} -> {event['domain']:<35} "
            f"{event['bytes']/1024:>6.1f}KB"
        )

    monitor = DNSMonitor(config, on_event)
    monitor.start()

    print("\nSyphir DNS Monitor — watching simulated network traffic")
    print("Ctrl+C to stop\n")

    try:
        while True:
            time.sleep(10)
            stats = monitor.get_stats()
            print(f"\n--- Stats: {stats['total_queries']} queries | {stats['ai_queries']} AI ---\n")
    except KeyboardInterrupt:
        monitor.stop()
        print(f"\nStopped. Saw {len(seen)} DNS events.")