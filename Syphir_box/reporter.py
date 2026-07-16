"""
Syphir Shield — reporter.py
Formats raw detection events into the Syphir incident schema
and posts them to the API. Same format the Chrome extension uses
so everything shows up in the same dashboard seamlessly.
"""

import json
import time
import uuid
import logging
import threading
from datetime import datetime
from pathlib import Path
from collections import deque

import urllib.request
import urllib.error

log = logging.getLogger('syphir.reporter')

BASE_DIR = Path(__file__).parent


# ── Incident schema ──────────────────────────────────────────────────────────
def build_incident(verdict, risk_level, config):
    """
    Converts a raw verdict from the decision engine into the
    exact incident schema the Syphir API expects.
    Mirrors what the Chrome extension sends so the dashboard
    treats it identically.
    """
    tool    = verdict['tool']
    session = verdict['session']

    total_kb = session['bytes'] / 1024
    duration = (
        (session['last_seen'] - session['first_seen']).total_seconds()
        if session['first_seen'] != session['last_seen'] else 1
    )

    return {
        # Core fields (match Chrome extension schema exactly)
        'id':           f"inc_{uuid.uuid4().hex[:20]}",
        'org_key':      config['org_key'],
        'device_key':   config['device_key'],
        'source':       'network',              # tells dashboard: Shield, not browser
        'risk_level':   risk_level,
        'ai_tool':      tool['name'],
        'user_email':   None,                   # filled in later when IP->employee mapping exists
        'ip_address':   verdict['ip'],
        'timestamp':    datetime.utcnow().isoformat() + 'Z',
        'resolved':     False,

        # Detection detail
        'detections': [
            {
                'type':        'NETWORK_DATA_VOLUME',
                'label':       f"{total_kb:.1f}KB to {tool['name']}",
                'entity_type': 'NETWORK',
                'isCode':      False,
                'value':       f"{total_kb:.1f}KB in {duration:.0f}s",
                'domain':      verdict['domain'],
            }
        ],

        # Shield-specific metadata
        'shield_meta': {
            'domain':        verdict['domain'],
            'bytes_sent':    session['bytes'],
            'queries':       session['queries'],
            'duration_secs': round(duration),
            'risk_weight':   tool.get('risk_weight', 1.0),
            'reason':        verdict['reason'],
            'provider':      tool.get('provider', 'Unknown'),
            'device_name':   config.get('device_name', 'Syphir Shield'),
            'firmware':      config.get('firmware_version', '1.0.0'),
        }
    }


# ── Offline queue ────────────────────────────────────────────────────────────
class OfflineQueue:
    """
    If the API is unreachable, incidents go here.
    A background thread retries every 60s until they get through.
    Nothing gets lost.
    """

    QUEUE_FILE = BASE_DIR / 'offline_queue.json'

    def __init__(self):
        self._queue   = deque()
        self._lock    = threading.Lock()
        self._running = False
        self._load()

    def push(self, incident):
        with self._lock:
            self._queue.append(incident)
            self._save()
        log.debug(f"Queued incident {incident['id']} for retry")

    def pop(self):
        with self._lock:
            if self._queue:
                item = self._queue.popleft()
                self._save()
                return item
        return None

    def size(self):
        return len(self._queue)

    def _save(self):
        try:
            with open(self.QUEUE_FILE, 'w') as f:
                # Convert deque to list for JSON serialization
                items = list(self._queue)
                # datetime objects aren't JSON serializable — already strings in our schema
                json.dump(items, f, indent=2, default=str)
        except Exception as e:
            log.warning(f"Could not save offline queue: {e}")

    def _load(self):
        if self.QUEUE_FILE.exists():
            try:
                with open(self.QUEUE_FILE) as f:
                    items = json.load(f)
                    self._queue = deque(items)
                if self._queue:
                    log.info(f"Loaded {len(self._queue)} queued incidents from disk")
            except Exception as e:
                log.warning(f"Could not load offline queue: {e}")


# ── Deduplication ────────────────────────────────────────────────────────────
class DedupeCache:
    """
    Prevents the same incident from being logged twice.
    Key: (ip, domain, risk_level) within a 5 minute window.
    """

    def __init__(self, ttl_seconds=300):
        self._cache = {}
        self._ttl   = ttl_seconds

    def is_duplicate(self, incident):
        key = (
            incident.get('ip_address'),
            incident['shield_meta']['domain'],
            incident['risk_level']
        )
        now = time.time()

        if key in self._cache:
            if now - self._cache[key] < self._ttl:
                return True

        self._cache[key] = now
        return False

    def cleanup(self):
        now = time.time()
        self._cache = {k: v for k, v in self._cache.items() if now - v < self._ttl}


# ── Reporter ─────────────────────────────────────────────────────────────────
class Reporter:

    def __init__(self, config):
        self.config  = config
        self.api_url = config['api_url']
        self.queue   = OfflineQueue()
        self.dedupe  = DedupeCache(ttl_seconds=300)
        self._start_retry_worker()

    def send(self, verdict, risk_level):
        """
        Main entry point called by server.py when an incident needs logging.
        Builds the incident, deduplicates, then tries to POST to the API.
        Falls back to offline queue if API is unreachable.
        """
        incident = build_incident(verdict, risk_level, self.config)

        # Deduplicate
        if self.dedupe.is_duplicate(incident):
            log.debug(f"Duplicate incident suppressed: {incident['shield_meta']['domain']}")
            return None

        log.info(
            f"Reporting [{risk_level.upper()}] | "
            f"{verdict['ip']} -> {verdict['tool']['name']} | "
            f"{incident['shield_meta']['bytes_sent']/1024:.1f}KB"
        )

        success = self._post(incident)
        if not success:
            self.queue.push(incident)
            log.warning(f"API unreachable — incident queued ({self.queue.size()} pending)")

        return incident

    def _post(self, incident):
        """POST incident to Syphir API. Returns True on success."""
        try:
            payload = json.dumps(incident, default=str).encode()
            req = urllib.request.Request(
                f"{self.api_url}/incidents",
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                if res.status in (200, 201):
                    log.info(f"Incident logged: {incident['id']}")
                    return True
                else:
                    log.warning(f"API returned {res.status} for incident {incident['id']}")
                    return False

        except urllib.error.URLError as e:
            log.warning(f"API unreachable: {e.reason}")
            return False
        except Exception as e:
            log.warning(f"POST failed: {e}")
            return False

    def _start_retry_worker(self):
        """Background thread that drains the offline queue when API comes back."""
        def worker():
            while True:
                time.sleep(60)
                if self.queue.size() == 0:
                    continue

                log.info(f"Retrying {self.queue.size()} queued incident(s)...")
                sent = 0
                failed = 0

                while self.queue.size() > 0:
                    incident = self.queue.pop()
                    if incident is None:
                        break
                    if self._post(incident):
                        sent += 1
                    else:
                        self.queue.push(incident)
                        failed += 1
                        break  # API still down — stop trying, wait for next cycle

                if sent:
                    log.info(f"Retry: {sent} incident(s) sent successfully")
                if failed:
                    log.warning(f"Retry: API still unreachable, {self.queue.size()} remaining in queue")

                self.dedupe.cleanup()

        threading.Thread(target=worker, daemon=True).start()
        log.info("Offline retry worker started")


# ── Quick test ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG, format='%(asctime)s  [%(levelname)s]  %(message)s')

    from datetime import datetime

    config = {
        'device_key':       'SYP-NET-TEST-0001',
        'org_key':          'SYP-AZNC-Y8DX-MJ9K',
        'api_url':          'https://syphir-api.onrender.com',
        'device_name':      'Syphir Shield',
        'firmware_version': '1.0.0',
    }

    reporter = Reporter(config)

    # Simulate a warn-level verdict
    now = datetime.utcnow()
    test_verdict = {
        'verdict': 'warn',
        'ip':      '192.168.1.42',
        'domain':  'claude.ai',
        'reason':  'Elevated data volume: 32KB to Claude in 45s',
        'tool': {
            'name':        'Claude',
            'provider':    'Anthropic',
            'domain':      'claude.ai',
            'risk_weight': 1.0,
        },
        'session': {
            'bytes':      32768,
            'queries':    8,
            'first_seen': now,
            'last_seen':  now,
            'alerted':    False,
            'escalated':  False,
        }
    }

    print("\nSending test incident to Syphir API...")
    result = reporter.send(test_verdict, risk_level='medium')
    if result:
        print(f"\nIncident built successfully:")
        print(json.dumps(result, indent=2, default=str))
    else:
        print("Send failed — check API connection")

    time.sleep(2)