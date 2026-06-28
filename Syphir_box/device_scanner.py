"""
Syphir Shield — Device Scanner
Runs on the Raspberry Pi 5, discovers all devices on the local network,
identifies them by MAC vendor, hostname, and open ports, then pushes
live updates to the Syphir API.

Requirements: pip install scapy requests netifaces zeroconf
System:       sudo apt install nmap arp-scan
"""

import asyncio
import json
import logging
import os
import re
import socket
import subprocess
import threading
import time
from datetime import datetime
from typing import Dict, Optional

import requests

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger('DeviceScanner')

# ── Config ────────────────────────────────────────────────────────────────────
API_URL      = os.getenv('SYPHIR_API_URL',  'https://syphir-api.onrender.com')
API_KEY      = os.getenv('SYPHIR_API_KEY',  '')
ORG_KEY      = os.getenv('SYPHIR_ORG_KEY',  '')
SCAN_INTERVAL = int(os.getenv('SCAN_INTERVAL', '30'))   # seconds between scans
SUBNET       = os.getenv('SUBNET', '')                  # auto-detected if empty

# ── MAC vendor prefix database (top ~80 manufacturers) ───────────────────────
MAC_VENDORS = {
    '00:1A:2B': 'Cisco',         '00:50:56': 'VMware',
    '00:0C:29': 'VMware',        'AC:DE:48': 'Apple',
    '00:1C:B3': 'Apple',         '00:23:12': 'Apple',
    'A4:C3:F0': 'Apple',         '04:4B:ED': 'Apple',
    'F0:18:98': 'Apple',         '8C:85:90': 'Apple',
    '00:1A:73': 'Apple',         'B8:E8:56': 'Apple',
    '3C:D0:F8': 'Apple',         '00:17:F2': 'Apple',
    'DC:2B:2A': 'Apple',         '14:10:9F': 'Apple',
    '00:1B:63': 'Apple',         '40:6C:8F': 'Apple',
    '00:26:BB': 'Apple',         'A8:51:AB': 'Apple',
    '00:23:DF': 'Apple',         'C8:2A:14': 'Apple',
    '00:11:24': 'Apple',         'F4:F1:5A': 'Apple',
    '60:03:08': 'Apple',         '8C:2D:AA': 'Apple',
    '00:25:00': 'Apple',         '20:C9:D0': 'Apple',
    # Samsung
    '00:12:47': 'Samsung',       '00:16:32': 'Samsung',
    '00:17:C9': 'Samsung',       '00:1A:8A': 'Samsung',
    '10:1D:C0': 'Samsung',       '34:23:BA': 'Samsung',
    '50:CC:F8': 'Samsung',       '70:F0:27': 'Samsung',
    'AC:36:13': 'Samsung',       'CC:07:AB': 'Samsung',
    # Dell
    '00:14:22': 'Dell',          '00:21:70': 'Dell',
    '00:22:19': 'Dell',          'B8:AC:6F': 'Dell',
    'F8:DB:88': 'Dell',          '18:03:73': 'Dell',
    # HP/Hewlett-Packard
    '00:1F:29': 'HP',            '00:21:5A': 'HP',
    '00:25:B3': 'HP',            '3C:D9:2B': 'HP',
    'A0:D3:C1': 'HP',            'FC:15:B4': 'HP',
    # Lenovo
    '00:21:CC': 'Lenovo',        'E8:39:35': 'Lenovo',
    '28:D2:44': 'Lenovo',        '54:EE:75': 'Lenovo',
    # Microsoft
    '00:15:5D': 'Microsoft',     '28:18:78': 'Microsoft',
    '7C:1E:52': 'Microsoft',     '00:50:F2': 'Microsoft',
    # Intel (NUC, NIC)
    '00:02:B3': 'Intel',         '00:12:F0': 'Intel',
    '00:19:D1': 'Intel',         '00:1B:21': 'Intel',
    # Google
    '54:60:09': 'Google',        'F4:F5:D8': 'Google',
    '94:EB:2C': 'Google',        '20:DF:B9': 'Google',
    # Amazon (Echo, Fire)
    '40:B4:CD': 'Amazon',        '74:75:48': 'Amazon',
    'A4:08:F5': 'Amazon',        'FC:A6:67': 'Amazon',
    # Raspberry Pi Foundation
    'B8:27:EB': 'Raspberry Pi',  'DC:A6:32': 'Raspberry Pi',
    'E4:5F:01': 'Raspberry Pi',
    # TP-Link
    '00:27:19': 'TP-Link',       '14:CC:20': 'TP-Link',
    '50:C7:BF': 'TP-Link',       'B0:BE:76': 'TP-Link',
    # Netgear
    '00:09:5B': 'Netgear',       '00:14:6C': 'Netgear',
    '20:4E:7F': 'Netgear',       'C0:3F:0E': 'Netgear',
    # Unknown / common
    '00:00:00': 'Unknown',
}

# ── Device type inference ─────────────────────────────────────────────────────
def infer_device_type(vendor: str, hostname: str, open_ports: list) -> str:
    vendor_l   = vendor.lower()
    hostname_l = (hostname or '').lower()

    if any(x in hostname_l for x in ['iphone', 'ipad']):    return 'iPhone/iPad'
    if 'macbook' in hostname_l:                               return 'MacBook'
    if 'mac' in hostname_l and 'apple' in vendor_l:          return 'Mac'
    if any(x in hostname_l for x in ['android', 'pixel', 'galaxy']): return 'Android Phone'
    if 'printer' in hostname_l or 80 in open_ports:          return 'Printer'
    if 'router' in hostname_l or 'gateway' in hostname_l:    return 'Router'
    if 'raspberry' in vendor_l:                              return 'Raspberry Pi'
    if 'amazon' in vendor_l:                                 return 'Smart Device'
    if 'google' in vendor_l:                                 return 'Google Device'
    if 'samsung' in vendor_l and not any(p in open_ports for p in [80,443,22]): return 'Phone'
    if vendor_l in ['dell', 'hp', 'lenovo', 'microsoft']:   return 'Laptop/PC'
    if 22 in open_ports:                                     return 'Server/Linux'
    if 80 in open_ports or 443 in open_ports:               return 'Server'
    return 'Device'

# ── Location hint from hostname ───────────────────────────────────────────────
def infer_location(hostname: str) -> str:
    h = (hostname or '').lower()
    for keyword in ['lobby', 'reception', 'front', 'entry']:
        if keyword in h: return 'Lobby'
    for keyword in ['office', 'desk', 'work']:
        if keyword in h: return 'Office'
    for keyword in ['conf', 'meeting', 'room']:
        if keyword in h: return 'Conference Room'
    for keyword in ['server', 'rack', 'nas']:
        if keyword in h: return 'Server Room'
    return 'Network'

# ── MAC vendor lookup ─────────────────────────────────────────────────────────
def lookup_vendor(mac: str) -> str:
    if not mac: return 'Unknown'
    prefix = mac.upper()[:8]
    return MAC_VENDORS.get(prefix, MAC_VENDORS.get(prefix[:5], 'Unknown'))

# ── Get local subnet ──────────────────────────────────────────────────────────
def get_subnet() -> str:
    if SUBNET: return SUBNET
    try:
        import netifaces
        for iface in ['eth0', 'wlan0', 'en0', 'ens3']:
            addrs = netifaces.ifaddresses(iface)
            if netifaces.AF_INET in addrs:
                ip   = addrs[netifaces.AF_INET][0]['addr']
                # Convert to /24 subnet
                parts = ip.rsplit('.', 1)
                return f"{parts[0]}.0/24"
    except Exception:
        pass
    # Fallback: detect from routing table
    try:
        result = subprocess.run(['ip', 'route'], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            if 'src' in line and '192.168' in line:
                match = re.search(r'(192\.168\.\d+)\.0/24', line)
                if match: return match.group(0)
        # Try common subnet
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        parts = ip.rsplit('.', 1)
        return f"{parts[0]}.0/24"
    except Exception:
        return '192.168.1.0/24'

# ── Run nmap scan ─────────────────────────────────────────────────────────────
def run_nmap_scan(subnet: str) -> list:
    """Fast ping scan to find live hosts, then quick port scan on found hosts."""
    log.info(f'Scanning subnet: {subnet}')
    devices = []

    try:
        # Phase 1: fast ping scan
        result = subprocess.run(
            ['nmap', '-sn', '--host-timeout', '5s', '-T4', subnet],
            capture_output=True, text=True, timeout=60
        )
        # Parse nmap output
        current = {}
        for line in result.stdout.splitlines():
            if 'Nmap scan report' in line:
                if current: devices.append(current)
                ip = re.search(r'(\d+\.\d+\.\d+\.\d+)', line)
                current = {
                    'ip':        ip.group(1) if ip else '',
                    'hostname':  '',
                    'mac':       '',
                    'vendor':    'Unknown',
                    'ports':     [],
                    'status':    'up',
                }
                # Try to get hostname from parens
                h = re.search(r'\((.+?)\)', line)
                if h: current['hostname'] = h.group(1)
            elif 'MAC Address:' in line and current:
                mac_match = re.search(r'([0-9A-Fa-f:]{17})', line)
                if mac_match:
                    current['mac'] = mac_match.group(1)
                    current['vendor'] = lookup_vendor(current['mac'])
                    # Vendor may also be in parens after MAC
                    v = re.search(r'\((.+?)\)', line)
                    if v and v.group(1) != 'Unknown':
                        current['vendor'] = v.group(1)
        if current: devices.append(current)

    except subprocess.TimeoutExpired:
        log.warning('nmap scan timed out')
    except FileNotFoundError:
        log.warning('nmap not found — using arp-scan fallback')
        devices = arp_scan_fallback(subnet)
    except Exception as e:
        log.error(f'nmap error: {e}')

    return [d for d in devices if d.get('ip')]

# ── ARP scan fallback (if nmap not installed) ─────────────────────────────────
def arp_scan_fallback(subnet: str) -> list:
    devices = []
    try:
        result = subprocess.run(
            ['arp-scan', '--localnet'],
            capture_output=True, text=True, timeout=30
        )
        for line in result.stdout.splitlines():
            parts = line.split('\t')
            if len(parts) >= 3 and re.match(r'\d+\.\d+\.\d+\.\d+', parts[0]):
                ip, mac, vendor = parts[0].strip(), parts[1].strip(), parts[2].strip()
                devices.append({
                    'ip': ip, 'mac': mac, 'vendor': vendor or lookup_vendor(mac),
                    'hostname': '', 'ports': [], 'status': 'up'
                })
    except Exception as e:
        log.error(f'arp-scan error: {e}')
    return devices

# ── Resolve hostname via reverse DNS ──────────────────────────────────────────
def resolve_hostname(ip: str) -> str:
    try:
        return socket.gethostbyaddr(ip)[0]
    except Exception:
        return ''

# ── Quick port check on common ports ─────────────────────────────────────────
def quick_port_check(ip: str, ports=(22, 80, 443, 8080, 3389, 5900)) -> list:
    open_ports = []
    for port in ports:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.5)
            if s.connect_ex((ip, port)) == 0:
                open_ports.append(port)
            s.close()
        except Exception:
            pass
    return open_ports

# ── Build enriched device record ──────────────────────────────────────────────
def enrich_device(raw: dict) -> dict:
    ip       = raw['ip']
    mac      = raw.get('mac', '')
    vendor   = raw.get('vendor', 'Unknown')
    hostname = raw.get('hostname', '') or resolve_hostname(ip)
    ports    = raw.get('ports', []) or quick_port_check(ip)

    device_type = infer_device_type(vendor, hostname, ports)
    location    = infer_location(hostname)

    return {
        'ip':          ip,
        'mac':         mac,
        'hostname':    hostname or ip,
        'vendor':      vendor,
        'device_type': device_type,
        'location':    location,
        'open_ports':  ports,
        'status':      'up',
        'last_seen':   datetime.utcnow().isoformat() + 'Z',
        'first_seen':  raw.get('first_seen', datetime.utcnow().isoformat() + 'Z'),
    }

# ── Push device list to Syphir API ────────────────────────────────────────────
def push_to_api(devices: list, subnet: str):
    if not API_URL:
        log.warning('No API URL set — skipping push')
        return

    payload = {
        'org_key':   ORG_KEY,
        'subnet':    subnet,
        'device_count': len(devices),
        'devices':   devices,
        'scanned_at': datetime.utcnow().isoformat() + 'Z',
    }

    try:
        r = requests.post(
            f'{API_URL}/shield/devices',
            json=payload,
            headers={'x-api-key': API_KEY, 'Content-Type': 'application/json'},
            timeout=10
        )
        if r.status_code == 200:
            log.info(f'Pushed {len(devices)} devices to API')
        else:
            log.warning(f'API responded {r.status_code}: {r.text[:100]}')
    except requests.exceptions.ConnectionError:
        log.warning('API unreachable — will retry next scan')
    except Exception as e:
        log.error(f'Push error: {e}')

# ── Main scanner loop ─────────────────────────────────────────────────────────
class DeviceScanner:
    def __init__(self):
        self.subnet      = get_subnet()
        self.known       : Dict[str, dict] = {}  # ip → device
        self.running     = True

        log.info(f'Device Scanner starting — subnet: {self.subnet}')
        log.info(f'Scan interval: {SCAN_INTERVAL}s')
        log.info(f'API: {API_URL}')

    def scan_once(self):
        raw_devices = run_nmap_scan(self.subnet)
        now = datetime.utcnow().isoformat() + 'Z'

        # Enrich each found device
        enriched = []
        for raw in raw_devices:
            ip = raw['ip']
            if ip in self.known:
                raw['first_seen'] = self.known[ip].get('first_seen', now)
            device = enrich_device(raw)
            self.known[ip] = device
            enriched.append(device)

        # Mark devices not seen this scan as 'away'
        seen_ips = {d['ip'] for d in enriched}
        for ip, device in self.known.items():
            if ip not in seen_ips:
                device['status'] = 'away'
                enriched.append(device)

        log.info(f'Found {len([d for d in enriched if d["status"]=="up"])} devices up, '
                 f'{len([d for d in enriched if d["status"]=="away"])} away')

        for d in enriched:
            if d['status'] == 'up':
                log.info(f'  {d["ip"]:16} {d["device_type"]:16} {d["vendor"]:20} '
                         f'{d["hostname"][:30]:30} [{d["location"]}]')

        push_to_api(enriched, self.subnet)
        return enriched

    def run(self):
        while self.running:
            try:
                self.scan_once()
            except KeyboardInterrupt:
                break
            except Exception as e:
                log.error(f'Scan error: {e}')
            time.sleep(SCAN_INTERVAL)

    def stop(self):
        self.running = False
        log.info('Device Scanner stopped')


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    scanner = DeviceScanner()
    try:
        scanner.run()
    except KeyboardInterrupt:
        scanner.stop()
        log.info('Goodbye.')