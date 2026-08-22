"""
Syphir Shield — command_poller.py
Polls the Syphir API every 5 seconds for pending admin commands
(isolate/release/block/unblock/status/ping), runs them for real
against the firewall or network, and reports back what actually
happened.

This is the real dispatch path for Intel — replaces the old
localhost:7474 stub, which only ever ran things on whatever machine
had local_server.py open, never the Block itself.
"""

import json
import time
import logging
import threading
import subprocess
from datetime import datetime
from pathlib import Path

import urllib.request
import urllib.error

log = logging.getLogger('syphir.command_poller')

BASE_DIR = Path(__file__).parent


class CommandPoller:

    def __init__(self, config, firewall, interval_seconds=5):
        self.config   = config
        self.firewall = firewall
        self.interval = interval_seconds
        self.api_url  = config['api_url']

        self._running = False
        self._thread  = None

    # ── Public ───────────────────────────────────────────────────────────────
    def start(self):
        self._running = True
        self._thread  = threading.Thread(target=self._loop, daemon=True, name='command_poller')
        self._thread.start()
        log.info(f"Command poller started — checking every {self.interval}s")

    def stop(self):
        self._running = False
        log.info("Command poller stopped")

    # ── Internal ─────────────────────────────────────────────────────────────
    def _loop(self):
        while self._running:
            self._check_for_commands()
            time.sleep(self.interval)

    def _check_for_commands(self):
        try:
            req = urllib.request.Request(
                f"{self.api_url}/shield/command/pending?key={self.config['org_key']}",
                method='GET'
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                data = json.loads(res.read().decode())
                commands = data.get('commands', [])
        except Exception as e:
            log.debug(f"Command poll failed (non-fatal): {e}")
            return

        for cmd in commands:
            self._execute(cmd)

    def _execute(self, cmd):
        cmd_id     = cmd.get('id')
        action     = cmd.get('action')
        target_ip  = cmd.get('target_ip')
        reason     = cmd.get('reason') or f"Intel command: {action}"

        log.info(f"Executing command {cmd_id}: {action} {target_ip or ''}")

        try:
            if action == 'isolate':
                success = self.firewall.isolate_device(target_ip, reason)
                message = f"{target_ip} isolated — cut off from network, Shield connection preserved." if success \
                    else f"Couldn't isolate {target_ip} — your Block may need a quick check to make sure it's set up correctly."
            elif action == 'release':
                success = self.firewall.release_device(target_ip, released_by='intel')
                message = f"{target_ip} released back onto the network." if success \
                    else f"Couldn't release {target_ip} — try again in a moment."
            elif action == 'block':
                success = self.firewall.block_ip(target_ip, reason)
                message = f"{target_ip} blocked." if success \
                    else f"Couldn't block {target_ip} — your Block may need a quick check to make sure it's set up correctly."
            elif action == 'unblock':
                success = self.firewall.unblock_ip(target_ip)
                message = f"{target_ip} unblocked." if success \
                    else f"Couldn't unblock {target_ip} — try again in a moment."
            elif action == 'status':
                status  = self.firewall.get_status()
                success = True
                message = f"Shield online. {len(status.get('isolated_devices', {}))} isolated, {len(status.get('blocked_ips', {}))} blocked."
            elif action == 'ping':
                success, message = self._ping(target_ip)
            else:
                success = False
                message = f"Unknown action: {action}"
        except Exception as e:
            success = False
            message = f"Command failed: {e}"
            log.error(f"Command {cmd_id} raised an exception: {e}")

        self._report_result(cmd_id, success, message)

    def _ping(self, ip):
        """Real ICMP ping from the Pi itself — no firewall.py needed for this one."""
        try:
            result = subprocess.run(
                ['ping', '-c', '3', '-W', '2', ip],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                return True, f"{ip} is reachable."
            return False, f"{ip} did not respond to ping — may be offline or blocking ICMP."
        except FileNotFoundError:
            return False, "ping command not found on this device."
        except subprocess.TimeoutExpired:
            return False, f"Ping to {ip} timed out."
        except Exception as e:
            return False, f"Ping failed: {e}"

    def _report_result(self, cmd_id, success, message):
        payload = json.dumps({'success': success, 'message': message}).encode()
        try:
            req = urllib.request.Request(
                f"{self.api_url}/shield/command/{cmd_id}/result",
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                log.info(f"Command {cmd_id} result reported: success={success}")
        except Exception as e:
            log.warning(f"Could not report result for {cmd_id} (non-fatal): {e}")


# ── Standalone test ───────────────────────────────────────────────────────────
if __name__ == '__main__':
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    class FakeFirewall:
        """Lets you test the poller loop itself without real hardware."""
        def isolate_device(self, ip, reason):
            print(f"[FAKE] would isolate {ip} — {reason}")
            return True
        def release_device(self, ip, released_by='admin'):
            print(f"[FAKE] would release {ip}")
            return True
        def block_ip(self, ip, reason):
            print(f"[FAKE] would block {ip} — {reason}")
            return True
        def unblock_ip(self, ip):
            print(f"[FAKE] would unblock {ip}")
            return True
        def get_status(self):
            return {'isolated_devices': {}, 'blocked_ips': {}}

    config = {
        'org_key': 'SYP-AZNC-Y8DX-MJ9K',
        'api_url': 'https://syphir-api.onrender.com',
    }

    poller = CommandPoller(config, FakeFirewall(), interval_seconds=5)
    poller.start()

    print("\nCommand poller running — checking for pending commands every 5s (Ctrl+C to stop)\n")

    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        poller.stop()
        print("\nStopped.")