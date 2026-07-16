"""
Syphir Shield — blocker.py
The coordinator between Layer 1 (detection) and Layer 2 (response).
ALL threats route through containment.py for confidence scoring first.
Nothing gets blocked or isolated without hitting the threshold.
"""

import json
import time
import logging
import threading
from datetime import datetime
from pathlib import Path

log = logging.getLogger('syphir.blocker')

BASE_DIR = Path(__file__).parent

DEFAULT_BLOCK_EXPIRY = 60


class Blocker:
    """
    Receives threat events from IntrusionDetector.
    Routes through Containment for confidence scoring first.
    Only acts when score crosses the threshold.
    """

    def __init__(self, config, firewall, reporter, notifier_push, agent_runner, containment=None):
        self.config        = config
        self.firewall      = firewall
        self.reporter      = reporter
        self.notify        = notifier_push
        self.runner        = agent_runner
        self.containment   = containment   # set after containment is instantiated
        self._queue        = []
        self._queue_lock   = threading.Lock()
        self._running      = False
        self._response_log = []

    def set_containment(self, containment):
        """Wire containment after both objects are created."""
        self.containment = containment

    def start(self):
        self._running = True
        threading.Thread(target=self._process_loop, daemon=True, name='blocker').start()
        log.info("Blocker started")

    def stop(self):
        self._running = False

    def on_threat(self, threat, context=None):
        """
        Entry point from IntrusionDetector.
        If containment is wired, score first. Otherwise act directly.
        """
        with self._queue_lock:
            self._queue.append((threat, context))

    def _process_loop(self):
        while self._running:
            item = None
            with self._queue_lock:
                if self._queue:
                    item = self._queue.pop(0)
            if item:
                threat, context = item
                try:
                    self._handle(threat, context)
                except Exception as e:
                    log.error(f"Blocker error: {e}")
            else:
                time.sleep(0.1)

    def _handle(self, threat, context):
        # Route through containment scoring if available
        if self.containment:
            score, verdict, case_id = self.containment.evaluate_and_respond(threat, context)
            log.info(f"Containment scored {score}/100 → {verdict} for {threat.get('name','?')}")
            # Containment already called on_threat_direct if action needed
            return

        # Fallback: direct handling without scoring (should not normally happen)
        log.warning("Containment not wired — acting directly on threat")
        self._act(threat)

    def on_threat_direct(self, threat):
        """
        Called by containment AFTER scoring confirms action is needed.
        This is where the actual response happens.
        """
        response  = threat.get('response', 'alert')
        risk      = threat.get('risk', 'medium')
        src_ip    = threat.get('src_ip', '')
        dst_ip    = threat.get('dst_ip', '')
        sig_id    = threat.get('signature_id', 'unknown')
        detail    = threat.get('detail', '')
        name      = threat.get('name', 'Unknown threat')
        taken     = []

        log.info(f"Acting on scored threat [{risk.upper()}] {sig_id} — {name} | response={response}")

        # 1. Log to dashboard
        self._log_incident(threat)
        taken.append('logged')

        # 2. Notify admin
        self._notify_admin(threat)
        taken.append('admin_notified')

        # 3. Block external IP
        if response in ('block_and_alert', 'isolate_and_alert'):
            if src_ip and not self._is_lan(src_ip):
                self.firewall.block_ip(
                    src_ip,
                    reason=f"{sig_id}: {name} — {detail[:100]}",
                    expires_minutes=DEFAULT_BLOCK_EXPIRY
                )
                taken.append(f'blocked_{src_ip}')
            if dst_ip and not self._is_lan(dst_ip):
                self.firewall.block_ip(
                    dst_ip,
                    reason=f"Malicious destination — {name}",
                    expires_minutes=DEFAULT_BLOCK_EXPIRY
                )
                taken.append(f'blocked_dst_{dst_ip}')

        # 4. Isolate LAN device
        if response == 'isolate_and_alert':
            device_ip = src_ip if self._is_lan(src_ip) else None
            if device_ip:
                self.firewall.isolate_device(
                    device_ip,
                    reason=f"{sig_id}: {name}",
                    signature_id=sig_id
                )
                taken.append(f'isolated_{device_ip}')

                # 5. Deploy defense agent if enabled
                if self.config.get('auto_deploy_defense_agent', False):
                    log.info(f"Auto-deploying defense agent to {device_ip}")
                    threading.Thread(
                        target=self._deploy_defense_agent,
                        args=(device_ip, threat),
                        daemon=True
                    ).start()
                    taken.append(f'agent_dispatched_{device_ip}')

                self._notify_employee(device_ip, threat)
                taken.append('employee_notified')

        self._response_log.append({
            'timestamp':     datetime.utcnow().isoformat(),
            'threat':        name,
            'signature_id':  sig_id,
            'risk':          risk,
            'response':      response,
            'actions_taken': taken,
            'src_ip':        src_ip,
        })
        if len(self._response_log) > 500:
            self._response_log = self._response_log[-500:]

        log.info(f"Response complete — actions: {', '.join(taken)}")

    def _act(self, threat):
        """Direct act without scoring — fallback only."""
        self.on_threat_direct(threat)

    def _log_incident(self, threat):
        try:
            verdict = {
                'verdict': 'critical' if threat.get('risk') in ('critical', 'high') else 'warn',
                'tool':    {
                    'name':        f"Network — {threat.get('name','Intrusion')}",
                    'domain':      threat.get('domain', threat.get('dst_ip', 'unknown')),
                    'risk_weight': 1.0,
                },
                'session': {
                    'bytes': 0, 'queries': 1,
                    'first_seen': datetime.utcnow(),
                    'last_seen':  datetime.utcnow(),
                    'alerted': False, 'escalated': False,
                },
                'ip':             threat.get('src_ip', ''),
                'domain':         threat.get('domain', threat.get('dst_ip', '')),
                'reason':         threat.get('detail', threat.get('name', '')),
                'monitor_type':   'intrusion',
                'signature_id':   threat.get('signature_id', ''),
            }
            risk = 'high' if threat.get('risk') in ('critical', 'high') else 'medium'
            self.reporter.send(verdict, risk)
        except Exception as e:
            log.warning(f"Could not log incident: {e}")

    def _notify_admin(self, threat):
        try:
            risk  = threat.get('risk', 'medium')
            level = 'critical' if risk in ('critical', 'high') else 'warn'
            self.notify(
                level  = level,
                tool   = 'Network Intrusion',
                reason = f"{threat.get('name','Threat')}: {threat.get('detail','')[:120]}",
            )
        except Exception as e:
            log.warning(f"Could not notify admin: {e}")

    def _notify_employee(self, device_ip, threat):
        try:
            self.notify(
                level  = 'critical',
                tool   = 'Network Security',
                reason = (
                    "Your device has been isolated from the network by Syphir Shield. "
                    "A security concern was detected. Your IT administrator has been notified."
                ),
            )
        except Exception as e:
            log.warning(f"Could not notify employee: {e}")

    def _deploy_defense_agent(self, device_ip, threat):
        reason = f"Defense deployment — {threat.get('name','Intrusion')}: {threat.get('detail','')[:100]}"
        try:
            self.runner.dispatch(
                employee_ip = device_ip,
                reason      = reason,
                mode        = 'defend',
            )
        except Exception as e:
            log.error(f"Defense agent dispatch failed: {e}")

    def _is_lan(self, ip):
        try:
            import ipaddress
            return ipaddress.ip_address(ip).is_private
        except Exception:
            return False

    def get_response_log(self):
        return list(self._response_log)

    # ── Public ────────────────────────────────────────────────────────────────

    def start(self):
        self._running = True
        threading.Thread(target=self._process_loop, daemon=True, name='blocker').start()
        log.info("Blocker started")

    def stop(self):
        self._running = False


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
    from containment  import Containment

    with open(BASE_DIR / 'threat_intel.json') as f:
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
    fw.start()

    blocker = Blocker(config, fw, reporter, notify_push, runner)
    containment = Containment(config, blocker, threat_intel)
    blocker.set_containment(containment)
    blocker.start()

    print("\nSyphir Blocker — scored threat coordination test\n")
    print("=" * 56)

    tests = [
        {
            'label': 'John uploads to Dropbox at 2pm (should be WATCH)',
            'threat': {
                'signature_id': 'AS009',
                'name':         'Large upload',
                'src_ip':       '192.168.1.42',
                'domain':       'dropbox.com',
                'detail':       '192.168.1.42 sent 8MB to dropbox.com',
                'risk':         'medium',
            },
            'context': {'bytes_sent': 8_000_000, 'domain': 'dropbox.com', 'hour': 14},
        },
        {
            'label': 'External SSH brute force (should BLOCK)',
            'threat': {
                'signature_id': 'AS003',
                'name':         'Brute force SSH',
                'src_ip':       '203.0.113.5',
                'detail':       '203.0.113.5 made 8 SSH attempts',
                'risk':         'critical',
            },
            'context': {'hour': 3},
        },
        {
            'label': 'John hits ngrok — C2 domain (should ISOLATE)',
            'threat': {
                'signature_id': 'AS012',
                'name':         'C2 domain connection',
                'src_ip':       '192.168.1.42',
                'domain':       'ngrok.io',
                'detail':       '192.168.1.42 connected to ngrok.io',
                'risk':         'critical',
            },
            'context': {'domain': 'ngrok.io', 'hour': 14},
        },
    ]

    for t in tests:
        print(f"\n  [{t['label']}]")
        blocker.on_threat(t['threat'], t['context'])
        time.sleep(1)

    print("\n--- Firewall Status ---")
    status = fw.get_status()
    print(f"  Blocked IPs      : {list(status['blocked_ips'].keys())}")
    print(f"  Isolated devices : {list(status['isolated_devices'].keys())}")

    blocker.stop()
    fw.stop()
    print("\nDone.")