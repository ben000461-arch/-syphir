"""
Syphir Shield — agent_runner.py
Simulates the box dispatching the agent to an employee machine.
On the actual Pi this becomes the real SSH push.
Right now it runs the agent locally so you can test the full flow.
"""

import json
import time
import logging
import platform
import subprocess
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

log = logging.getLogger('syphir.runner')

BASE_DIR = Path(__file__).parent


class AgentRunner:

    def __init__(self, config):
        self.config  = config
        self.api_url = config['api_url']

    # ── Main dispatch entry point ─────────────────────────────────────────────

    def dispatch(self, employee_ip, reason, mode='diagnostic', tool=None, data_kb=None):
        """
        Dispatch the agent to an employee machine.

        mode:
          'diagnostic' — scans only, no changes
          'repair'     — full repair run

        On the Pi: SSH pushes agent.py to employee machine and runs it.
        Right now: runs agent.py locally to simulate the full flow.
        """
        incident = {
            'reason':        reason,
            'tool':          tool or 'Unknown',
            'bytes_kb':      str(data_kb or 0),
            'mode':          mode,
            'dispatch_type': 'box_initiated',
            'employee_ip':   employee_ip,
            'timestamp':     datetime.utcnow().isoformat() + 'Z',
        }

        log.info(f"Dispatching agent | mode={mode} | ip={employee_ip} | reason={reason}")

        if self.config.get('simulation_mode', True):
            return self._dispatch_local(incident)
        else:
            return self._dispatch_ssh(employee_ip, incident)

    # ── Local dispatch (simulation / testing) ─────────────────────────────────

    def _dispatch_local(self, incident):
        """
        Runs agent.py on this machine directly.
        Used for testing before Pi hardware arrives.
        """
        agent_path = BASE_DIR / 'agent.py'
        if not agent_path.exists():
            log.error("agent.py not found — cannot dispatch")
            return False

        log.info("[SIM] Running agent locally (simulation mode)")

        try:
            payload = json.dumps(incident)
            result  = subprocess.run(
                ['python3', str(agent_path), payload],
                timeout=120
            )
            success = result.returncode == 0
            log.info(f"Agent completed — returncode={result.returncode}")
            return success
        except subprocess.TimeoutExpired:
            log.error("Agent timed out after 120s")
            return False
        except Exception as e:
            log.error(f"Agent dispatch failed: {e}")
            return False

    # ── SSH dispatch (runs on Pi with real hardware) ──────────────────────────

    def _dispatch_ssh(self, employee_ip, incident):
        """
        Real dispatch over SSH.
        Copies agent.py to employee machine, runs it, done.
        Requires Pi hardware and SSH key setup.
        """
        agent_path   = BASE_DIR / 'agent.py'
        remote_path  = '/tmp/syphir_agent.py'
        employee_user = self.config.get('default_ssh_user', 'user')
        key_path      = self.config.get('ssh_key_path')

        # Build SSH base args
        ssh_base = [
            'ssh',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=8',
        ]
        if key_path:
            ssh_base += ['-i', key_path]

        scp_base = [
            'scp',
            '-o', 'StrictHostKeyChecking=no',
        ]
        if key_path:
            scp_base += ['-i', key_path]

        target = f"{employee_user}@{employee_ip}"

        # Step 1: Copy agent to employee machine
        log.info(f"SCP agent.py to {target}:{remote_path}")
        try:
            subprocess.run(
                scp_base + [str(agent_path), f"{target}:{remote_path}"],
                timeout=30, check=True
            )
        except subprocess.CalledProcessError as e:
            log.error(f"SCP failed: {e}")
            return False
        except subprocess.TimeoutExpired:
            log.error("SCP timed out")
            return False

        # Step 2: Run agent on employee machine
        payload    = json.dumps(incident).replace("'", '"')
        remote_cmd = f"python3 {remote_path} '{payload}'"

        log.info(f"SSH running agent on {target}")
        try:
            subprocess.run(
                ssh_base + [target, remote_cmd],
                timeout=120
            )
            log.info("Agent completed on remote machine")
            return True
        except subprocess.TimeoutExpired:
            log.error("SSH agent timed out")
            return False
        except Exception as e:
            log.error(f"SSH dispatch failed: {e}")
            return False

    # ── Box-initiated: check approval before dispatching ──────────────────────

    def request_and_wait(self, employee_ip, reason, mode='repair', tool=None, data_kb=None):
        """
        Box-initiated flow:
        1. Posts dispatch request to API (shows as approval card in dashboard)
        2. Polls for admin approval
        3. Dispatches if approved, cancels if denied or timeout
        """
        log.info(f"Requesting approval for {mode} dispatch to {employee_ip}")

        # Post request to API
        request_id = self._post_dispatch_request(employee_ip, reason, mode)
        if not request_id:
            log.error("Could not post dispatch request to API")
            return False

        # Poll for approval
        approved = self._poll_approval(request_id)
        if not approved:
            log.info("Dispatch not approved — cancelling")
            return False

        # Approved — dispatch
        return self.dispatch(employee_ip, reason, mode, tool, data_kb)

    def _post_dispatch_request(self, employee_ip, reason, mode):
        try:
            payload = json.dumps({
                'device_key':    self.config['device_key'],
                'org_key':       self.config['org_key'],
                'employee_ip':   employee_ip,
                'reason':        reason,
                'dispatch_type': mode,
                'timestamp':     datetime.utcnow().isoformat() + 'Z',
                'status':        'pending',
            }).encode()

            req = urllib.request.Request(
                f"{self.api_url}/shield/dispatch-request",
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                data = json.loads(res.read().decode())
                log.info(f"Dispatch request posted: {data.get('request_id')}")
                return data.get('request_id')
        except Exception as e:
            log.warning(f"Could not post dispatch request: {e}")
            return None

    def _poll_approval(self, request_id, timeout_seconds=300):
        log.info(f"Waiting for admin approval of request {request_id}")
        elapsed = 0

        while elapsed < timeout_seconds:
            time.sleep(10)
            elapsed += 10
            try:
                req = urllib.request.Request(
                    f"{self.api_url}/shield/dispatch-request/{request_id}",
                    method='GET'
                )
                with urllib.request.urlopen(req, timeout=10) as res:
                    data   = json.loads(res.read().decode())
                    status = data.get('status')

                    if status == 'approved':
                        log.info("Admin approved dispatch")
                        return True
                    elif status == 'denied':
                        log.info("Admin denied dispatch")
                        return False
                    else:
                        log.debug(f"Still waiting for approval ({elapsed}s)...")
            except Exception:
                pass

        log.warning("Approval timed out after 5 minutes")
        return False


# ── Standalone test ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s  [%(levelname)s]  %(message)s'
    )

    # Load config
    config_path = BASE_DIR / 'config.json'
    if config_path.exists():
        with open(config_path) as f:
            config = json.load(f)
    else:
        config = {
            'device_key':      'SYP-NET-TEST-0001',
            'org_key':         'SYP-AZNC-Y8DX-MJ9K',
            'api_url':         'https://syphir-api.onrender.com',
            'simulation_mode': True,
        }

    runner = AgentRunner(config)

    print("\nSyphir Shield — Agent Runner Test")
    print("=" * 40)
    print("1. Run diagnostic agent")
    print("2. Run repair agent")
    print()

    choice = input("Choose (1 or 2): ").strip()

    if choice == '1':
        runner.dispatch(
            employee_ip = '192.168.1.42',
            reason      = 'High data volume detected on Claude — 45KB in 60s',
            mode        = 'diagnostic',
            tool        = 'Claude',
            data_kb     = 45
        )
    elif choice == '2':
        runner.dispatch(
            employee_ip = '192.168.1.42',
            reason      = 'Admin requested repair — machine reported as unresponsive',
            mode        = 'repair',
        )
    else:
        print("Invalid choice")