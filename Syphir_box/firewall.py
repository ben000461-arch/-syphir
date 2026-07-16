"""
Syphir Shield — firewall.py
Layer 2: Active response. Blocks IPs and isolates compromised devices.
Manages iptables rules on the Pi.
On Mac/dev: runs in stub mode — prints exactly what it would do.
"""

import json
import time
import logging
import threading
import subprocess
import ipaddress
from datetime import datetime
from pathlib import Path
from collections import defaultdict

log = logging.getLogger('syphir.firewall')

BASE_DIR      = Path(__file__).parent
STATE_FILE    = BASE_DIR / 'firewall_state.json'
SHIELD_IP     = '10.0.0.1'   # Pi's own IP on the network — always kept open


# ── Firewall state ────────────────────────────────────────────────────────────

class FirewallState:
    """Persists blocked IPs and isolated devices across restarts."""

    def __init__(self):
        self._state = {
            'blocked_ips':       {},   # ip -> {reason, blocked_at, expires_at}
            'isolated_devices':  {},   # ip -> {reason, isolated_at, signature_id}
        }
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if STATE_FILE.exists():
            try:
                with open(STATE_FILE) as f:
                    self._state = json.load(f)
                log.info(
                    f"Firewall state loaded — "
                    f"{len(self._state['blocked_ips'])} blocked, "
                    f"{len(self._state['isolated_devices'])} isolated"
                )
            except Exception as e:
                log.warning(f"Could not load firewall state: {e}")

    def _save(self):
        try:
            with open(STATE_FILE, 'w') as f:
                json.dump(self._state, f, indent=2, default=str)
        except Exception as e:
            log.warning(f"Could not save firewall state: {e}")

    def add_blocked(self, ip, reason, expires_minutes=None):
        with self._lock:
            self._state['blocked_ips'][ip] = {
                'reason':     reason,
                'blocked_at': datetime.utcnow().isoformat(),
                'expires_at': None if not expires_minutes else (
                    datetime.utcnow().timestamp() + expires_minutes * 60
                )
            }
            self._save()

    def remove_blocked(self, ip):
        with self._lock:
            self._state['blocked_ips'].pop(ip, None)
            self._save()

    def is_blocked(self, ip):
        with self._lock:
            return ip in self._state['blocked_ips']

    def add_isolated(self, ip, reason, signature_id=''):
        with self._lock:
            self._state['isolated_devices'][ip] = {
                'reason':       reason,
                'isolated_at':  datetime.utcnow().isoformat(),
                'signature_id': signature_id,
            }
            self._save()

    def remove_isolated(self, ip):
        with self._lock:
            self._state['isolated_devices'].pop(ip, None)
            self._save()

    def is_isolated(self, ip):
        with self._lock:
            return ip in self._state['isolated_devices']

    def get_blocked(self):
        with self._lock:
            return dict(self._state['blocked_ips'])

    def get_isolated(self):
        with self._lock:
            return dict(self._state['isolated_devices'])


# ── iptables runner ───────────────────────────────────────────────────────────

class IPTables:
    """
    Wrapper around iptables commands.
    Stub mode: prints commands instead of running them.
    Live mode: executes on the Pi (requires root).
    """

    def __init__(self, stub_mode=True):
        self.stub = stub_mode
        if stub_mode:
            log.info("Firewall in STUB mode — commands will be printed, not executed")
        else:
            log.info("Firewall in LIVE mode — iptables rules will be applied")

    def run(self, args, description=''):
        cmd = ['iptables'] + args
        if self.stub:
            log.info(f"[STUB] {description}: {' '.join(cmd)}")
            return True
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode == 0:
                log.debug(f"iptables OK: {' '.join(cmd)}")
                return True
            else:
                log.error(f"iptables failed: {result.stderr.strip()}")
                return False
        except subprocess.TimeoutExpired:
            log.error(f"iptables timeout: {' '.join(cmd)}")
            return False
        except FileNotFoundError:
            log.error("iptables not found — are you on the Pi?")
            return False
        except Exception as e:
            log.error(f"iptables error: {e}")
            return False

    def block_ip(self, ip):
        """Block all traffic from a source IP."""
        self.run(['-I', 'FORWARD', '-s', ip, '-j', 'DROP'],
                 f"Block inbound from {ip}")
        self.run(['-I', 'INPUT', '-s', ip, '-j', 'DROP'],
                 f"Block input from {ip}")

    def unblock_ip(self, ip):
        """Remove block on a source IP."""
        self.run(['-D', 'FORWARD', '-s', ip, '-j', 'DROP'],
                 f"Unblock forward from {ip}")
        self.run(['-D', 'INPUT', '-s', ip, '-j', 'DROP'],
                 f"Unblock input from {ip}")

    def isolate_device(self, device_ip, shield_ip=SHIELD_IP):
        """
        Isolate a LAN device — cut it off from internet AND other LAN devices.
        But keep Shield <-> device connection open so agent can still get in.
        """
        # Allow Shield to reach isolated device (agent needs this)
        self.run(['-I', 'FORWARD', '-s', shield_ip, '-d', device_ip, '-j', 'ACCEPT'],
                 f"Keep Shield->device open for {device_ip}")
        self.run(['-I', 'FORWARD', '-s', device_ip, '-d', shield_ip, '-j', 'ACCEPT'],
                 f"Keep device->Shield open for {device_ip}")

        # Block everything else to/from the device
        self.run(['-I', 'FORWARD', '-s', device_ip, '-j', 'DROP'],
                 f"Block all outbound from {device_ip}")
        self.run(['-I', 'FORWARD', '-d', device_ip, '-j', 'DROP'],
                 f"Block all inbound to {device_ip}")

        log.warning(f"Device ISOLATED: {device_ip} — cut off from network. Shield connection preserved.")

    def release_device(self, device_ip, shield_ip=SHIELD_IP):
        """Release an isolated device back onto the network."""
        # Remove isolation rules
        self.run(['-D', 'FORWARD', '-s', shield_ip, '-d', device_ip, '-j', 'ACCEPT'],
                 f"Remove Shield->device exception for {device_ip}")
        self.run(['-D', 'FORWARD', '-s', device_ip, '-d', shield_ip, '-j', 'ACCEPT'],
                 f"Remove device->Shield exception for {device_ip}")
        self.run(['-D', 'FORWARD', '-s', device_ip, '-j', 'DROP'],
                 f"Remove outbound block for {device_ip}")
        self.run(['-D', 'FORWARD', '-d', device_ip, '-j', 'DROP'],
                 f"Remove inbound block for {device_ip}")

        log.info(f"Device RELEASED: {device_ip} — network access restored")

    def flush_all(self):
        """Clear all Syphir-managed rules. Nuclear option."""
        self.run(['-F', 'FORWARD'], "Flush all FORWARD rules")
        self.run(['-F', 'INPUT'],   "Flush all INPUT rules")
        log.warning("All firewall rules flushed")


# ── Firewall ──────────────────────────────────────────────────────────────────

class Firewall:
    """
    Main Layer 2 active response class.
    Called by blocker.py when a threat needs a response.
    """

    def __init__(self, config, on_action=None):
        self.config    = config
        self.on_action = on_action or (lambda a: None)
        self._state    = FirewallState()
        self._iptables = IPTables(
            stub_mode=config.get('simulation_mode', True)
        )
        self._running  = False

    def start(self):
        self._running = True
        # Restore rules from previous session
        self._restore_rules()
        # Start expiry checker
        threading.Thread(target=self._expiry_loop, daemon=True, name='fw-expiry').start()
        log.info("Firewall started")

    def stop(self):
        self._running = False

    # ── Public response actions ───────────────────────────────────────────────

    def block_ip(self, ip, reason, expires_minutes=None):
        """Block an external IP from reaching the network."""
        if self._state.is_blocked(ip):
            log.debug(f"IP {ip} already blocked")
            return

        self._iptables.block_ip(ip)
        self._state.add_blocked(ip, reason, expires_minutes)

        action = {
            'action':      'block_ip',
            'ip':          ip,
            'reason':      reason,
            'expires_min': expires_minutes,
            'timestamp':   datetime.utcnow().isoformat(),
        }
        log.warning(f"BLOCKED: {ip} — {reason}")
        self.on_action(action)

    def unblock_ip(self, ip):
        """Unblock a previously blocked IP."""
        if not self._state.is_blocked(ip):
            log.debug(f"IP {ip} not in block list")
            return

        self._iptables.unblock_ip(ip)
        self._state.remove_blocked(ip)

        log.info(f"UNBLOCKED: {ip}")
        self.on_action({'action': 'unblock_ip', 'ip': ip, 'timestamp': datetime.utcnow().isoformat()})

    def isolate_device(self, device_ip, reason, signature_id=''):
        """
        Isolate a compromised LAN device.
        Cuts it off from everything except the Shield box.
        """
        if self._state.is_isolated(device_ip):
            log.debug(f"Device {device_ip} already isolated")
            return

        self._iptables.isolate_device(device_ip)
        self._state.add_isolated(device_ip, reason, signature_id)

        action = {
            'action':       'isolate_device',
            'device_ip':    device_ip,
            'reason':       reason,
            'signature_id': signature_id,
            'timestamp':    datetime.utcnow().isoformat(),
        }
        log.error(f"ISOLATED: {device_ip} — {reason}")
        self.on_action(action)

    def release_device(self, device_ip, released_by='admin'):
        """
        Release an isolated device back onto the network.
        Called when admin confirms device is clean.
        """
        if not self._state.is_isolated(device_ip):
            log.debug(f"Device {device_ip} not isolated")
            return

        self._iptables.release_device(device_ip)
        self._state.remove_isolated(device_ip)

        action = {
            'action':      'release_device',
            'device_ip':   device_ip,
            'released_by': released_by,
            'timestamp':   datetime.utcnow().isoformat(),
        }
        log.info(f"RELEASED: {device_ip} by {released_by}")
        self.on_action(action)

    def get_status(self):
        """Return current firewall state — used by dashboard."""
        return {
            'blocked_ips':      self._state.get_blocked(),
            'isolated_devices': self._state.get_isolated(),
            'stub_mode':        self._iptables.stub,
        }

    # ── Internal ──────────────────────────────────────────────────────────────

    def _restore_rules(self):
        """Re-apply rules on startup in case Pi was rebooted."""
        blocked  = self._state.get_blocked()
        isolated = self._state.get_isolated()

        if blocked:
            log.info(f"Restoring {len(blocked)} block rules from previous session")
            for ip in blocked:
                self._iptables.block_ip(ip)

        if isolated:
            log.info(f"Restoring {len(isolated)} isolation rules from previous session")
            for ip in isolated:
                self._iptables.isolate_device(ip)

    def _expiry_loop(self):
        """Check for expired blocks and auto-remove them."""
        while self._running:
            now     = datetime.utcnow().timestamp()
            blocked = self._state.get_blocked()
            for ip, info in blocked.items():
                expires = info.get('expires_at')
                if expires and now > expires:
                    log.info(f"Block expired for {ip} — auto-removing")
                    self.unblock_ip(ip)
            time.sleep(60)


# ── Standalone test ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    config  = {'simulation_mode': True}
    actions = []

    def on_action(a):
        actions.append(a)
        print(f"\n  Action: {a['action']} | {a.get('ip') or a.get('device_ip')} | {a.get('reason','')}\n")

    fw = Firewall(config, on_action=on_action)
    fw.start()

    print("\nSyphir Firewall — Layer 2 test\n")
    print("=" * 48)

    print("\n1. Blocking external attacker IP...")
    fw.block_ip('203.0.113.5', 'SSH brute force — 8 attempts in 60s', expires_minutes=30)

    print("\n2. Isolating compromised device...")
    fw.isolate_device('192.168.1.42', 'C2 beacon detected — ngrok.io', signature_id='AS006')

    print("\n3. Firewall status:")
    status = fw.get_status()
    print(f"   Blocked IPs      : {list(status['blocked_ips'].keys())}")
    print(f"   Isolated devices : {list(status['isolated_devices'].keys())}")

    print("\n4. Admin releases isolated device after review...")
    fw.release_device('192.168.1.42', released_by='admin')

    print("\n5. Final status:")
    status = fw.get_status()
    print(f"   Blocked IPs      : {list(status['blocked_ips'].keys())}")
    print(f"   Isolated devices : {list(status['isolated_devices'].keys())}")

    print(f"\nDone. {len(actions)} firewall actions taken.")
    fw.stop()