"""
Syphir Shield — server.py
Main daemon. Runs on the Pi 24/7.

Full stack:
  Layer 0 — Data collection  : dns_monitor.py + packet_inspector.py
  Layer 1 — Detection        : intrusion_detector.py
  Layer 1b — AI/General mon  : AIDecisionEngine + GeneralDecisionEngine
  Layer 2 — Active response  : firewall.py + blocker.py
  Layer 3 — Confidence/Invest: containment.py
  Support  — reporter, heartbeat, notifier, agent_runner
"""

import ssl
ssl._create_default_https_context = ssl._create_unverified_context

import json
import time
import threading
import logging
import sys
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

# Support modules
from reporter          import Reporter
from heartbeat         import Heartbeat
from agent_runner      import AgentRunner
from notifier          import push as notify_push

# Data collection
from dns_monitor       import DNSMonitor       as RealDNSMonitor
from packet_inspector  import PacketInspector

# Detection
from intrusion_detector import IntrusionDetector

# Active response
from firewall          import Firewall
from blocker           import Blocker

# Confidence + investigation
from containment       import Containment

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  [%(levelname)s]  %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path(__file__).parent / 'syphir.log')
    ]
)
log = logging.getLogger('syphir')

BASE_DIR = Path(__file__).parent


def load_json(filename):
    path = BASE_DIR / filename
    if not path.exists():
        log.error(f"Missing config file: {filename}")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


# Session tracker
class SessionTracker:
    def __init__(self, window_minutes=10):
        self.window   = timedelta(minutes=window_minutes)
        self.sessions = defaultdict(lambda: defaultdict(lambda: {
            'bytes': 0, 'queries': 0,
            'first_seen': None, 'last_seen': None,
            'alerted': False, 'escalated': False,
        }))

    def record(self, ip, domain, byte_count):
        now = datetime.utcnow()
        s   = self.sessions[ip][domain]
        if s['last_seen'] and (now - s['last_seen']) > self.window:
            self.sessions[ip][domain] = {
                'bytes': 0, 'queries': 0,
                'first_seen': None, 'last_seen': None,
                'alerted': False, 'escalated': False,
            }
            s = self.sessions[ip][domain]
        s['bytes']   += byte_count
        s['queries'] += 1
        s['last_seen'] = now
        if not s['first_seen']:
            s['first_seen'] = now
        return s

    def mark_alerted(self, ip, domain):
        self.sessions[ip][domain]['alerted'] = True

    def mark_escalated(self, ip, domain):
        self.sessions[ip][domain]['escalated'] = True

    def clear_expired(self):
        now = datetime.utcnow()
        for ip in list(self.sessions.keys()):
            for domain in list(self.sessions[ip].keys()):
                last = self.sessions[ip][domain]['last_seen']
                if last and (now - last) > self.window * 3:
                    del self.sessions[ip][domain]


# AI Decision Engine
class AIDecisionEngine:
    def __init__(self, rules, domains):
        self.rules      = rules
        self.domains    = {d['domain']: d for d in domains['ai_tools']}
        self.thresholds = rules['thresholds']
        self.tracker    = SessionTracker(window_minutes=rules['session_window_minutes'])

    def get_tool_info(self, domain):
        for known_domain, info in self.domains.items():
            if known_domain in domain:
                return info
        return None

    def evaluate(self, event):
        ip       = event['ip']
        domain   = event['domain']
        bytes_in = event.get('bytes', 0)
        tool     = self.get_tool_info(domain)
        if not tool:
            return None

        session       = self.tracker.record(ip, domain, bytes_in)
        total_bytes   = session['bytes']
        total_queries = session['queries']
        duration_secs = (
            (session['last_seen'] - session['first_seen']).total_seconds()
            if session['first_seen'] != session['last_seen'] else 1
        )

        risk_weight = tool.get('risk_weight', 1.0)
        warn_bytes  = int(self.thresholds['warn_bytes']     / risk_weight)
        crit_bytes  = int(self.thresholds['critical_bytes'] / risk_weight)

        if total_bytes < warn_bytes and total_queries < self.thresholds['warn_queries']:
            return {'verdict': 'watch', 'tool': tool, 'session': session,
                    'ip': ip, 'domain': domain, 'reason': 'Normal AI usage', 'monitor_type': 'ai'}

        if total_bytes >= crit_bytes and not session['escalated']:
            self.tracker.mark_escalated(ip, domain)
            return {
                'verdict': 'critical', 'tool': tool, 'session': session,
                'ip': ip, 'domain': domain, 'monitor_type': 'ai',
                'reason': f"High-volume data exfiltration risk: {total_bytes/1024:.1f}KB to {tool['name']}"
            }

        if total_bytes >= warn_bytes and not session['alerted']:
            self.tracker.mark_alerted(ip, domain)
            return {
                'verdict': 'warn', 'tool': tool, 'session': session,
                'ip': ip, 'domain': domain, 'monitor_type': 'ai',
                'reason': f"Elevated data volume: {total_bytes/1024:.1f}KB to {tool['name']} in {duration_secs:.0f}s"
            }
        return None


# General Network Decision Engine
class GeneralDecisionEngine:
    def __init__(self, rules, domains):
        self.rules      = rules
        self.thresholds = rules['category_thresholds']
        self.tracker    = SessionTracker(window_minutes=rules['session_window_minutes'])
        self.domain_map = {}
        for category, items in domains.items():
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and 'domain' in item:
                        self.domain_map[item['domain']] = {
                            'category':    category,
                            'name':        item.get('name', item['domain']),
                            'risk_weight': item.get('risk_weight', 1.0),
                            'domain':      item['domain'],
                        }
        self.excluded = set(domains.get('excluded_domains', []))

    def get_domain_info(self, domain):
        if domain in self.excluded:
            return None
        for known, info in self.domain_map.items():
            if known in domain:
                return info
        return None

    def evaluate(self, event):
        ip       = event['ip']
        domain   = event['domain']
        bytes_in = event.get('bytes', 0)
        info     = self.get_domain_info(domain)
        if not info:
            return None

        category    = info['category']
        risk_weight = info.get('risk_weight', 1.0)
        cat_thresh  = self.thresholds.get(category)
        if not cat_thresh:
            return None

        session       = self.tracker.record(ip, domain, bytes_in)
        total_bytes   = session['bytes']
        duration_secs = (
            (session['last_seen'] - session['first_seen']).total_seconds()
            if session['first_seen'] != session['last_seen'] else 1
        )

        hour             = datetime.utcnow().hour
        time_rules       = self.rules.get('time_based_rules', {})
        biz_start        = time_rules.get('business_hours_start', 7)
        biz_end          = time_rules.get('business_hours_end', 20)
        after_mult       = time_rules.get('after_hours_multiplier', 0.5)
        is_after_hours   = hour < biz_start or hour >= biz_end

        warn_bytes = int(cat_thresh['warn_bytes'] / risk_weight)
        crit_bytes = int(cat_thresh['critical_bytes'] / risk_weight)
        if is_after_hours:
            warn_bytes = int(warn_bytes * after_mult)
            crit_bytes = int(crit_bytes * after_mult)

        tool_like = {'name': info['name'], 'domain': domain, 'risk_weight': risk_weight}

        if total_bytes < warn_bytes:
            return {'verdict': 'watch', 'tool': tool_like, 'session': session,
                    'ip': ip, 'domain': domain, 'monitor_type': 'general',
                    'category': category, 'reason': f"Normal {category} activity"}

        if total_bytes >= crit_bytes and not session['escalated']:
            self.tracker.mark_escalated(ip, domain)
            return {
                'verdict': 'critical', 'tool': tool_like, 'session': session,
                'ip': ip, 'domain': domain, 'monitor_type': 'general', 'category': category,
                'reason': f"{'After-hours ' if is_after_hours else ''}High-volume {category} transfer: {total_bytes/1024:.1f}KB to {info['name']}"
            }

        if total_bytes >= warn_bytes and not session['alerted']:
            self.tracker.mark_alerted(ip, domain)
            return {
                'verdict': 'warn', 'tool': tool_like, 'session': session,
                'ip': ip, 'domain': domain, 'monitor_type': 'general', 'category': category,
                'reason': f"{'After-hours ' if is_after_hours else ''}{category.replace('_',' ').title()} transfer: {total_bytes/1024:.1f}KB to {info['name']} in {duration_secs:.0f}s"
            }
        return None


# Unified dispatcher for AI + General traffic
class DataDispatcher:
    def __init__(self, reporter, notifier, rules):
        self.reporter  = reporter
        self.notifier  = notifier
        self.rules     = rules

    def dispatch(self, verdict, risk):
        tool    = verdict['tool']
        ip      = verdict['ip']
        reason  = verdict['reason']
        data_kb = round(verdict['session']['bytes'] / 1024, 1)

        log.info(f"DISPATCH | risk={risk} | {ip} -> {tool['name']} | {reason}")

        self.reporter.send(verdict, risk)
        self.notifier(
            level   = 'critical' if risk == 'high' else 'warn',
            tool    = tool['name'],
            data_kb = data_kb,
            reason  = reason,
        )


# Network Monitor — wraps all data collection + both decision engines
class NetworkMonitor:
    def __init__(self, ai_engine, general_engine, data_dispatcher,
                 ids, config):
        self.ai_engine       = ai_engine
        self.gen_engine      = general_engine
        self.data_dispatcher = data_dispatcher
        self.ids             = ids       # IntrusionDetector
        self.config          = config
        self._dns_monitor    = None
        self._pkt_inspector  = None

    def start(self):
        self._dns_monitor = RealDNSMonitor(
            config   = self.config,
            on_event = self._on_dns_event
        )
        self._dns_monitor.start()

        self._pkt_inspector = PacketInspector(
            config   = self.config,
            on_event = self._on_packet_event
        )
        self._pkt_inspector.start()

        log.info("Network monitor started — AI + General + IDS active")

    def stop(self):
        if self._dns_monitor:   self._dns_monitor.stop()
        if self._pkt_inspector: self._pkt_inspector.stop()

    def inject_event(self, event):
        self._on_dns_event(event)

    def _on_dns_event(self, event):
        if self._pkt_inspector:
            self._pkt_inspector.record_dns(event['ip'], event['domain'])

        # Feed to IDS
        self.ids.on_dns_event(event)

        # Feed to AI + General engines
        self._process_data_event(event)

    def _on_packet_event(self, event):
        # Feed to IDS
        self.ids.on_packet_event(event)

        # Feed to data engines
        std = {
            'ip':     event.get('src_ip', event.get('ip', '')),
            'domain': event.get('domain', ''),
            'bytes':  event.get('bytes', 0),
        }
        if std['domain']:
            self._process_data_event(std)

    def _process_data_event(self, event):
        # AI engine first
        verdict = self.ai_engine.evaluate(event)
        if verdict:
            self._handle_data_verdict(verdict)
            return

        # General engine
        verdict = self.gen_engine.evaluate(event)
        if verdict:
            self._handle_data_verdict(verdict)

    def _handle_data_verdict(self, verdict):
        level = verdict['verdict']
        if level == 'watch':
            log.debug(f"WATCH | {verdict['reason']}")
            return
        risk = 'high' if level == 'critical' else 'medium'
        if level == 'warn':
            log.warning(f"WARN  | {verdict['reason']}")
        else:
            log.error(f"CRIT  | {verdict['reason']}")
        self.data_dispatcher.dispatch(verdict, risk=risk)


# Simulation
def _run_simulation(monitor, blocker):
    def sim():
        time.sleep(2)

        # AI monitoring scenarios
        log.info("[SIM] John opens Claude — small query (WATCH)")
        monitor.inject_event({'ip': '192.168.1.42', 'domain': 'claude.ai', 'bytes': 800})
        time.sleep(3)

        log.info("[SIM] John sends another message — still normal")
        monitor.inject_event({'ip': '192.168.1.42', 'domain': 'claude.ai', 'bytes': 1200})
        time.sleep(3)

        log.info("[SIM] John pastes large document — threshold approaching")
        monitor.inject_event({'ip': '192.168.1.42', 'domain': 'claude.ai', 'bytes': 28000})
        time.sleep(3)

        log.info("[SIM] Large payload — WARN triggered")
        monitor.inject_event({'ip': '192.168.1.42', 'domain': 'claude.ai', 'bytes': 15000})
        time.sleep(3)

        log.info("[SIM] Massive dump — CRITICAL triggered")
        monitor.inject_event({'ip': '192.168.1.42', 'domain': 'claude.ai', 'bytes': 80000})
        time.sleep(3)

        log.info("[SIM] Sarah opens ChatGPT — normal (WATCH)")
        monitor.inject_event({'ip': '192.168.1.55', 'domain': 'chat.openai.com', 'bytes': 500})
        time.sleep(3)

        # General network scenarios
        log.info("[SIM] Mike uploads to WeTransfer — general WARN")
        monitor.inject_event({'ip': '192.168.1.63', 'domain': 'wetransfer.com', 'bytes': 8000000})
        time.sleep(3)

        log.info("[SIM] Lisa posts to Pastebin — data transfer flag")
        monitor.inject_event({'ip': '192.168.1.71', 'domain': 'pastebin.com', 'bytes': 150000})
        time.sleep(3)

        # Intrusion scenarios — routed through confidence scorer
        log.info("[SIM] John hits ngrok — C2 domain (high confidence ISOLATE)")
        blocker.on_threat({
            'signature_id': 'AS012',
            'name':         'C2 domain connection',
            'src_ip':       '192.168.1.42',
            'domain':       'ngrok.io',
            'detail':       '192.168.1.42 connected to ngrok.io',
            'risk':         'critical',
        }, {'domain': 'ngrok.io', 'hour': datetime.utcnow().hour})
        time.sleep(3)

        log.info("[SIM] External SSH brute force (BLOCK)")
        blocker.on_threat({
            'signature_id': 'AS003',
            'name':         'Brute force SSH',
            'src_ip':       '203.0.113.5',
            'detail':       '203.0.113.5 — 8 SSH attempts in 60s',
            'risk':         'critical',
        }, {'hour': datetime.utcnow().hour})

    threading.Thread(target=sim, daemon=True).start()


# Main
def main():
    log.info("=" * 56)
    log.info("  Syphir Shield — Starting up")
    log.info("=" * 56)

    # Load all configs
    config          = load_json('config.json')
    rules           = load_json('rules.json')
    general_rules   = load_json('general_rules.json')
    ai_domains      = load_json('ai_domains.json')
    general_domains = load_json('general_domains.json')
    threat_intel    = load_json('threat_intel.json')

    log.info(f"Device key   : {config['device_key']}")
    log.info(f"Org          : {config['org_key']}")
    log.info(f"API          : {config['api_url']}")
    log.info(f"AI tools     : {len(ai_domains['ai_tools'])} domains")
    log.info(f"General      : {sum(len(v) for v in general_domains.values() if isinstance(v, list))} domains")
    log.info(f"C2 domains   : {len(threat_intel.get('known_c2_domains', []))} known")
    log.info(f"Signatures   : {len(threat_intel.get('attack_signatures', []))} loaded")
    log.info(f"AI warn      : {rules['thresholds']['warn_bytes']/1024:.0f}KB")
    log.info(f"AI critical  : {rules['thresholds']['critical_bytes']/1024:.0f}KB")

    # Boot support modules
    reporter = Reporter(config)
    runner   = AgentRunner(config)
    hb       = Heartbeat(config)

    # Boot Layer 2 — Firewall + Blocker (before containment so we can wire)
    firewall = Firewall(config)
    blocker  = Blocker(config, firewall, reporter, notify_push, runner)

    # Boot Layer 3 — Containment (scores before blocker acts)
    containment = Containment(config, blocker, threat_intel)
    blocker.set_containment(containment)

    # Boot Layer 1 — Intrusion Detector
    ids = IntrusionDetector(
        config   = config,
        on_threat = blocker.on_threat
    )

    # Boot AI + General decision engines
    ai_engine  = AIDecisionEngine(rules, ai_domains)
    gen_engine = GeneralDecisionEngine(general_rules, general_domains)

    # Data dispatcher for AI + General traffic
    data_dispatcher = DataDispatcher(reporter, notify_push, rules)

    # Network monitor — wires data collection to all engines
    monitor = NetworkMonitor(
        ai_engine        = ai_engine,
        general_engine   = gen_engine,
        data_dispatcher  = data_dispatcher,
        ids              = ids,
        config           = config,
    )

    # Start everything
    hb.start()
    firewall.start()
    blocker.start()
    ids.start()
    monitor.start()

    log.info("=" * 56)
    log.info("  Shield active — all systems running")
    log.info("  AI monitoring     : ON")
    log.info("  General monitoring: ON")
    log.info("  Intrusion detection: ON")
    log.info("  Active firewall   : ON (stub)" if config.get('simulation_mode') else "  Active firewall   : ON (live)")
    log.info("  Confidence scoring: ON (no false positives)")
    log.info("=" * 56)

    if config.get('simulation_mode', False):
        log.info("SIMULATION MODE — injecting test events in 2s")
        _run_simulation(monitor, blocker)

    try:
        while True:
            ai_engine.tracker.clear_expired()
            gen_engine.tracker.clear_expired()
            time.sleep(30)
    except KeyboardInterrupt:
        log.info("Shutting down Syphir Shield...")
        monitor.stop()
        ids.stop()
        blocker.stop()
        firewall.stop()
        hb.stop()
        log.info("Goodbye.")


if __name__ == '__main__':
    main()