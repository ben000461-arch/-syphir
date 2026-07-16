"""
Syphir Shield — containment.py
Layer 3: Confidence scoring, investigation, and recovery.

CRITICAL DESIGN PRINCIPLE:
  The system must NEVER overreact. John uploading a work document
  to Dropbox is not a threat. John's machine beaconing to a known
  C2 server at 2am is.

  Every potential threat gets a confidence score 0-100.
  Only high-confidence threats trigger isolation.
  The system gives benefit of the doubt on ambiguous signals.

Confidence thresholds:
  0-39   -> watch    (log silently)
  40-64  -> warn     (notify admin, no blocking)
  65-79  -> block    (block external IP, notify)
  80-100 -> isolate  (full isolation + defense agent request)
"""

import json
import time
import logging
import threading
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

log = logging.getLogger('syphir.containment')

BASE_DIR = Path(__file__).parent

# Confidence thresholds
THRESHOLD_WATCH   = 0
THRESHOLD_WARN    = 40
THRESHOLD_BLOCK   = 65
THRESHOLD_ISOLATE = 80


# ── Employee behavior baseline ─────────────────────────────────────────────────

class BehaviorBaseline:
    """
    Learns what's normal for each device over time.
    If John always uploads to Dropbox at 9am, that's normal.
    If he suddenly does it at 2am with 10x the volume, that's not.
    """

    BASELINE_FILE = BASE_DIR / 'behavior_baseline.json'

    def __init__(self):
        self._baselines = defaultdict(lambda: {
            'avg_bytes_per_session':   0,
            'typical_hours':           list(range(7, 20)),
            'known_domains':           [],
            'session_count':           0,
            'last_updated':            None,
        })
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if self.BASELINE_FILE.exists():
            try:
                with open(self.BASELINE_FILE) as f:
                    data = json.load(f)
                    for ip, baseline in data.items():
                        self._baselines[ip] = baseline
                log.info(f"Behavior baseline loaded for {len(self._baselines)} devices")
            except Exception as e:
                log.warning(f"Could not load baseline: {e}")

    def _save(self):
        try:
            with open(self.BASELINE_FILE, 'w') as f:
                json.dump(dict(self._baselines), f, indent=2, default=str)
        except Exception as e:
            log.warning(f"Could not save baseline: {e}")

    def record_normal_activity(self, ip, domain, bytes_sent, hour):
        """Called on every watch-level event to build the baseline."""
        with self._lock:
            b = self._baselines[ip]
            count = b['session_count']

            # Rolling average bytes
            b['avg_bytes_per_session'] = (
                (b['avg_bytes_per_session'] * count + bytes_sent) / (count + 1)
            )
            b['session_count'] += 1

            # Track known domains
            if domain and domain not in b['known_domains']:
                b['known_domains'].append(domain)
                b['known_domains'] = b['known_domains'][-100:]

            # Track active hours
            if hour not in b['typical_hours']:
                b['typical_hours'].append(hour)

            b['last_updated'] = datetime.utcnow().isoformat()

            # Save every 10 sessions
            if b['session_count'] % 10 == 0:
                self._save()

    def is_known_domain(self, ip, domain):
        with self._lock:
            return domain in self._baselines[ip]['known_domains']

    def is_typical_hour(self, ip, hour):
        with self._lock:
            return hour in self._baselines[ip]['typical_hours']

    def is_high_volume(self, ip, bytes_sent):
        """Is this significantly more than the device's normal?"""
        with self._lock:
            avg = self._baselines[ip]['avg_bytes_per_session']
            if avg == 0:
                return False
            return bytes_sent > avg * 3

    def get_session_count(self, ip):
        with self._lock:
            return self._baselines[ip]['session_count']


# ── Confidence scorer ─────────────────────────────────────────────────────────

class ConfidenceScorer:
    """
    Scores every potential threat 0-100 before any action is taken.
    Higher score = more confident it's a real threat.
    Gives benefit of the doubt on ambiguous signals.
    """

    def __init__(self, threat_intel, baseline):
        self._intel    = threat_intel
        self._baseline = baseline
        self._bad_domains = {
            d['domain']: d for d in threat_intel.get('known_c2_domains', [])
        }
        self._whitelist_domains = set(threat_intel.get('whitelist_domains', []))
        self._whitelist_ips     = set(threat_intel.get('whitelist_ips', []))

    def score(self, threat, context=None):
        """
        Calculate confidence score for a threat.
        Returns (score, reasons) tuple.

        context dict can include:
          - bytes_sent
          - domain
          - hour
          - src_ip
          - active_signatures (list of other sigs firing on same device)
        """
        context  = context or {}
        score    = 0
        reasons  = []
        src_ip   = threat.get('src_ip', '')
        domain   = context.get('domain') or threat.get('domain', '')
        bytes_s  = context.get('bytes_sent', 0)
        hour     = context.get('hour', datetime.utcnow().hour)
        sigs     = context.get('active_signatures', [])

        # ── Positive signals (increase confidence it's a real threat) ─────────

        # Known bad domain hit
        if domain and any(bad in domain for bad in self._bad_domains):
            score   += 40
            reasons.append(f"+40 known C2 domain: {domain}")

        # Known attack signature
        sig_id = threat.get('signature_id', '')
        if sig_id:
            sig_weights = {
                'AS001': 25,  # port scan horizontal
                'AS002': 25,  # port scan vertical
                'AS003': 40,  # SSH brute force — block
                'AS004': 40,  # RDP brute force — block
                'AS005': 55,  # lateral movement — isolate
                'AS006': 55,  # C2 beacon — isolate
                'AS007': 35,  # DNS tunneling
                'AS008': 55,  # reverse shell — isolate
                'AS009': 20,  # bulk exfil
                'AS010': 10,  # after-hours (weak alone)
                'AS011': 5,   # new device (very weak)
                'AS012': 55,  # known C2 domain — isolate
            }
            sig_score = sig_weights.get(sig_id, 20)
            score    += sig_score
            reasons.append(f"+{sig_score} signature {sig_id}")

        # After hours
        if hour < 7 or hour >= 20:
            score   += 15
            reasons.append(f"+15 after-hours activity ({hour:02d}:xx)")

        # Multiple signatures on same device — coordinated attack indicator
        if len(sigs) >= 2:
            score   += 20
            reasons.append(f"+20 multiple signatures on same device: {sigs}")
        elif len(sigs) == 1:
            score   += 10
            reasons.append(f"+10 one other signature on same device")

        # Volume significantly above this device's normal
        if src_ip and bytes_s and self._baseline.is_high_volume(src_ip, bytes_s):
            score   += 15
            reasons.append(f"+15 volume 3x+ above device baseline")

        # New behavior for this device
        if src_ip and domain and not self._baseline.is_known_domain(src_ip, domain):
            if self._baseline.get_session_count(src_ip) > 10:
                score   += 10
                reasons.append(f"+10 domain not in device's known history")

        # Unusual hour for this specific device
        if src_ip and not self._baseline.is_typical_hour(src_ip, hour):
            score   += 10
            reasons.append(f"+10 unusual hour for this device")

        # High risk signature (reverse shell, C2 beacon, lateral movement)
        if threat.get('risk') == 'critical':
            score   += 10
            reasons.append("+10 critical risk rating")

        # ── Negative signals (reduce confidence — probably not a threat) ──────

        # Whitelisted domain — reduce score but don't zero it out
        # A whitelisted domain can still be misused
        if domain and any(w in domain for w in self._whitelist_domains):
            score   -= 20
            reasons.append(f"-20 whitelisted domain: {domain}")

        # Whitelisted IP
        if src_ip in self._whitelist_ips:
            score   -= 50
            reasons.append(f"-50 whitelisted IP: {src_ip}")

        # New device with very few sessions — still learning baseline
        if src_ip and self._baseline.get_session_count(src_ip) < 5:
            score   -= 10
            reasons.append(f"-10 new device, baseline not established yet")

        # Normal business hours
        if 9 <= hour <= 17:
            score   -= 5
            reasons.append(f"-5 normal business hours")

        # Clamp to 0-100
        score = max(0, min(100, score))

        return score, reasons

    def verdict(self, score):
        """Convert score to action verdict."""
        if score >= THRESHOLD_ISOLATE:
            return 'isolate'
        if score >= THRESHOLD_BLOCK:
            return 'block'
        if score >= THRESHOLD_WARN:
            return 'warn'
        return 'watch'


# ── Active threat tracker ─────────────────────────────────────────────────────

class ActiveThreatTracker:
    """
    Tracks which signatures are currently active per device.
    Used by the confidence scorer to detect coordinated attacks.
    """

    def __init__(self, ttl_minutes=30):
        self._active = defaultdict(dict)  # ip -> {sig_id: timestamp}
        self._ttl    = timedelta(minutes=ttl_minutes)
        self._lock   = threading.Lock()

    def record(self, ip, sig_id):
        with self._lock:
            self._active[ip][sig_id] = datetime.utcnow()

    def get_active_for_ip(self, ip):
        with self._lock:
            now     = datetime.utcnow()
            active  = {
                s: ts for s, ts in self._active[ip].items()
                if now - ts < self._ttl
            }
            self._active[ip] = active
            return list(active.keys())

    def clear_device(self, ip):
        with self._lock:
            self._active.pop(ip, None)


# ── Investigation engine ──────────────────────────────────────────────────────

class Investigator:
    """
    Builds a forensic picture of what happened during an incident.
    Timeline, scope, what was accessed, what was exfiltrated.
    """

    def __init__(self, connection_tracker=None):
        self._tracker = connection_tracker
        self._cases   = {}

    def open_case(self, device_ip, threat):
        """Start an investigation case for a compromised device."""
        case_id = f"CASE-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{device_ip.replace('.', '')}"
        self._cases[case_id] = {
            'case_id':    case_id,
            'device_ip':  device_ip,
            'opened_at':  datetime.utcnow().isoformat(),
            'closed_at':  None,
            'status':     'open',
            'trigger':    threat,
            'timeline':   [],
            'findings':   [],
            'scope':      {'devices_affected': [device_ip]},
        }
        self._add_event(case_id, 'case_opened', f"Investigation opened: {threat.get('name','Unknown threat')}")
        log.info(f"Investigation case opened: {case_id} for {device_ip}")
        return case_id

    def add_finding(self, case_id, finding_type, detail):
        if case_id not in self._cases:
            return
        self._cases[case_id]['findings'].append({
            'type':      finding_type,
            'detail':    detail,
            'timestamp': datetime.utcnow().isoformat(),
        })

    def add_affected_device(self, case_id, ip):
        if case_id not in self._cases:
            return
        scope = self._cases[case_id]['scope']['devices_affected']
        if ip not in scope:
            scope.append(ip)

    def close_case(self, case_id, resolution='resolved'):
        if case_id not in self._cases:
            return
        self._cases[case_id]['status']    = resolution
        self._cases[case_id]['closed_at'] = datetime.utcnow().isoformat()
        self._add_event(case_id, 'case_closed', f"Case closed: {resolution}")
        log.info(f"Case {case_id} closed: {resolution}")

    def get_case(self, case_id):
        return self._cases.get(case_id, {}).copy()

    def get_open_cases(self):
        return {k: v for k, v in self._cases.items() if v['status'] == 'open'}

    def _add_event(self, case_id, event_type, detail):
        if case_id not in self._cases:
            return
        self._cases[case_id]['timeline'].append({
            'timestamp': datetime.utcnow().isoformat(),
            'type':      event_type,
            'detail':    detail,
        })


# ── Containment ───────────────────────────────────────────────────────────────

class Containment:
    """
    Layer 3 — puts it all together.
    Scores every threat before acting.
    Investigates confirmed incidents.
    Manages recovery.
    """

    def __init__(self, config, blocker, threat_intel):
        self.config      = config
        self.blocker     = blocker
        self._baseline   = BehaviorBaseline()
        self._scorer     = ConfidenceScorer(threat_intel, self._baseline)
        self._att        = ActiveThreatTracker()
        self._investigator = Investigator()
        self._open_cases = {}   # device_ip -> case_id

    def evaluate_and_respond(self, threat, context=None):
        """
        Main entry point. Every threat from Layer 1 comes here first.
        Scores it, decides what to do, then hands off to blocker.
        """
        src_ip = threat.get('src_ip', '')
        sig_id = threat.get('signature_id', '')

        # Track active signatures per device
        if src_ip and sig_id:
            self._att.record(src_ip, sig_id)

        # Build context for scoring
        ctx = context or {}
        ctx['active_signatures'] = self._att.get_active_for_ip(src_ip) if src_ip else []
        ctx['hour']              = datetime.utcnow().hour

        # Score the threat
        score, reasons = self._scorer.score(threat, ctx)
        verdict        = self._scorer.verdict(score)

        log.info(
            f"CONFIDENCE SCORE: {score}/100 → {verdict.upper()} | "
            f"{threat.get('name','?')} | {src_ip}"
        )
        for r in reasons:
            log.info(f"  scoring: {r}")

        # Record normal activity in baseline (for watch-level only)
        if verdict == 'watch' and src_ip:
            self._baseline.record_normal_activity(
                ip=src_ip,
                domain=ctx.get('domain', ''),
                bytes_sent=ctx.get('bytes_sent', 0),
                hour=ctx['hour'],
            )

        # Map verdict to response
        response_map = {
            'watch':   None,
            'warn':    'alert',
            'block':   'block_and_alert',
            'isolate': 'isolate_and_alert',
        }
        response = response_map.get(verdict)

        if response is None:
            log.debug(f"Score {score} — watch only, no action taken")
            return score, verdict, None

        # Override threat response with our calculated response
        threat_with_response = {**threat, 'response': response}
        self.blocker.on_threat_direct(threat_with_response)

        # Open investigation case for isolations
        case_id = None
        if verdict == 'isolate' and src_ip:
            if src_ip not in self._open_cases:
                case_id = self._investigator.open_case(src_ip, threat)
                self._open_cases[src_ip] = case_id
                self._investigator.add_finding(
                    case_id,
                    'initial_detection',
                    f"Confidence score: {score}/100. Reasons: {'; '.join(reasons)}"
                )
            else:
                case_id = self._open_cases[src_ip]
                self._investigator.add_finding(
                    case_id,
                    'additional_signature',
                    f"Additional signature {sig_id} detected. Score: {score}"
                )

        return score, verdict, case_id

    def resolve_incident(self, device_ip, resolution='clean', released_by='admin'):
        """
        Admin marks a device as clean and releases it.
        Closes the investigation case.
        """
        # Release from isolation via blocker -> firewall
        if hasattr(self.blocker, 'firewall'):
            self.blocker.firewall.release_device(device_ip, released_by=released_by)

        # Close case
        case_id = self._open_cases.pop(device_ip, None)
        if case_id:
            self._investigator.close_case(case_id, resolution)

        # Clear active threat signatures for this device
        self._att.clear_device(device_ip)

        log.info(f"Incident resolved for {device_ip} — {resolution} (by {released_by})")

    def get_open_cases(self):
        return self._investigator.get_open_cases()

    def get_case(self, case_id):
        return self._investigator.get_case(case_id)


# ── Standalone test ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    import sys
    sys.path.insert(0, str(BASE_DIR))

    from firewall     import Firewall
    from reporter     import Reporter
    from notifier     import push as notify_push
    from agent_runner import AgentRunner
    from blocker      import Blocker

    # Load threat intel
    intel_path = BASE_DIR / 'threat_intel.json'
    with open(intel_path) as f:
        threat_intel = json.load(f)

    config = {
        'simulation_mode':           True,
        'auto_deploy_defense_agent': False,
        'device_key':                'SYP-NET-TEST-0001',
        'org_key':                   'SYP-AZNC-Y8DX-MJ9K',
        'api_url':                   'https://syphir-api.onrender.com',
        'device_name':               'Syphir Shield',
        'firmware_version':          '1.0.0',
    }

    fw       = Firewall(config)
    reporter = Reporter(config)
    runner   = AgentRunner(config)
    blocker  = Blocker(config, fw, reporter, notify_push, runner)

    fw.start()
    blocker.start()

    containment = Containment(config, blocker, threat_intel)

    print("\nSyphir Containment — confidence scoring test")
    print("=" * 56)

    tests = [
        {
            'label': 'John uploads work doc to Dropbox at 2pm',
            'threat': {
                'signature_id': 'AS009',
                'name':         'Large upload',
                'src_ip':       '192.168.1.42',
                'domain':       'dropbox.com',
                'detail':       '192.168.1.42 sent 8MB to dropbox.com',
                'risk':         'medium',
            },
            'context': {'bytes_sent': 8_000_000, 'domain': 'dropbox.com', 'hour': 14},
            'expect': 'watch or warn',
        },
        {
            'label': 'John uploads to WeTransfer at 2am',
            'threat': {
                'signature_id': 'AS009',
                'name':         'After-hours large upload',
                'src_ip':       '192.168.1.42',
                'domain':       'wetransfer.com',
                'detail':       '192.168.1.42 sent 15MB to wetransfer.com at 2am',
                'risk':         'medium',
            },
            'context': {'bytes_sent': 15_000_000, 'domain': 'wetransfer.com', 'hour': 2},
            'expect': 'warn or block',
        },
        {
            'label': 'John hits known C2 domain (ngrok)',
            'threat': {
                'signature_id': 'AS012',
                'name':         'C2 domain connection',
                'src_ip':       '192.168.1.42',
                'domain':       'ngrok.io',
                'detail':       '192.168.1.42 connected to ngrok.io',
                'risk':         'critical',
            },
            'context': {'domain': 'ngrok.io', 'hour': 14},
            'expect': 'isolate',
        },
        {
            'label': 'External SSH brute force at 3am',
            'threat': {
                'signature_id': 'AS003',
                'name':         'Brute force SSH',
                'src_ip':       '203.0.113.5',
                'detail':       '203.0.113.5 made 8 SSH attempts',
                'risk':         'critical',
            },
            'context': {'hour': 3},
            'expect': 'block',
        },
        {
            'label': 'Sarah opens Google (normal use)',
            'threat': {
                'signature_id': 'AS009',
                'name':         'Outbound traffic',
                'src_ip':       '192.168.1.55',
                'domain':       'google.com',
                'detail':       'Normal browsing',
                'risk':         'low',
            },
            'context': {'bytes_sent': 50_000, 'domain': 'google.com', 'hour': 10},
            'expect': 'watch (ignored)',
        },
    ]

    for t in tests:
        print(f"\n  Test: {t['label']}")
        print(f"  Expected: {t['expect']}")
        score, verdict, case_id = containment.evaluate_and_respond(t['threat'], t['context'])
        color = {
            'watch':   '\033[90m',
            'warn':    '\033[93m',
            'block':   '\033[91m',
            'isolate': '\033[95m',
        }.get(verdict, '')
        reset = '\033[0m'
        print(f"  Result:   {color}Score {score}/100 → {verdict.upper()}{reset}")
        if case_id:
            print(f"  Case ID:  {case_id}")
        time.sleep(0.5)

    print("\n\nFinal firewall status:")
    status = fw.get_status()
    print(f"  Blocked IPs      : {list(status['blocked_ips'].keys())}")
    print(f"  Isolated devices : {list(status['isolated_devices'].keys())}")

    print("\nOpen investigation cases:")
    for case_id, case in containment.get_open_cases().items():
        print(f"  {case_id} | {case['device_ip']} | {len(case['findings'])} findings")

    blocker.stop()
    fw.stop()
    print("\nDone.")