"""
Syphir Shield — heartbeat.py
Pings the Syphir API every 60 seconds so the dashboard
shows "Shield Active" in the sidebar. If the ping stops,
the dashboard knows the box is offline or disconnected.
"""

import json
import time
import logging
import threading
from datetime import datetime
from pathlib import Path

import urllib.request
import urllib.error

log = logging.getLogger('syphir.heartbeat')

BASE_DIR = Path(__file__).parent


class Heartbeat:

    def __init__(self, config, interval_seconds=60):
        self.config   = config
        self.interval = interval_seconds
        self.api_url  = config['api_url']

        self._running      = False
        self._thread       = None
        self._last_success = None
        self._fail_count   = 0
        self._status       = 'starting'   # starting | active | degraded | offline

    # ── Public ───────────────────────────────────────────────────────────────
    def start(self):
        self._running = True
        self._thread  = threading.Thread(target=self._loop, daemon=True, name='heartbeat')
        self._thread.start()
        log.info(f"Heartbeat started — pinging every {self.interval}s")

    def stop(self):
        self._running = False
        log.info("Heartbeat stopped")

    def status(self):
        return {
            'status':       self._status,
            'last_success': self._last_success,
            'fail_count':   self._fail_count,
        }

    # ── Internal ─────────────────────────────────────────────────────────────
    def _loop(self):
        # Send first ping immediately on boot
        self._ping()

        while self._running:
            time.sleep(self.interval)
            self._ping()

    def _ping(self):
        payload = json.dumps({
            'device_key':       self.config['device_key'],
            'org_key':          self.config['org_key'],
            'status':           'active',
            'firmware_version': self.config.get('firmware_version', '1.0.0'),
            'device_name':      self.config.get('device_name', 'Syphir Shield'),
            'timestamp':        datetime.utcnow().isoformat() + 'Z',
        }).encode()

        try:
            req = urllib.request.Request(
                f"{self.api_url}/shield/heartbeat",
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                if res.status in (200, 201, 204):
                    self._on_success()
                else:
                    self._on_fail(f"HTTP {res.status}")

        except urllib.error.URLError as e:
            self._on_fail(str(e.reason))
        except Exception as e:
            self._on_fail(str(e))

    def _on_success(self):
        self._last_success = datetime.utcnow().isoformat()
        self._fail_count   = 0
        self._status       = 'active'
        log.debug(f"Heartbeat OK — {self._last_success}")

    def _on_fail(self, reason):
        self._fail_count += 1
        self._status = 'degraded' if self._fail_count < 3 else 'offline'
        log.warning(f"Heartbeat failed ({self._fail_count}x): {reason}")

        # After 3 consecutive failures log it clearly
        if self._fail_count == 3:
            log.error(
                "Shield has lost contact with Syphir API after 3 attempts. "
                "Dashboard will show device as offline. "
                "Incidents are still being queued locally."
            )


# ── Standalone test ───────────────────────────────────────────────────────────
if __name__ == '__main__':
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    config = {
        'device_key':       'SYP-NET-TEST-0001',
        'org_key':          'SYP-AZNC-Y8DX-MJ9K',
        'api_url':          'https://syphir-api.onrender.com',
        'device_name':      'Syphir Shield',
        'firmware_version': '1.0.0',
    }

    hb = Heartbeat(config, interval_seconds=10)
    hb.start()

    print("\nHeartbeat running — pinging API every 10s (Ctrl+C to stop)\n")

    try:
        while True:
            time.sleep(5)
            s = hb.status()
            print(f"  Status: {s['status']} | Last success: {s['last_success']} | Fails: {s['fail_count']}")
    except KeyboardInterrupt:
        hb.stop()
        print("\nStopped.")