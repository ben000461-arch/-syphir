"""
Syphir Shield — local_server.py
Tiny local bridge server. Runs on port 7474.
Intel dashboard talks to this, it opens a real terminal
and runs agent.py for real on this machine.

Run with: python3 local_server.py
"""

import json
import subprocess
import threading
import platform
import os
import time
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

BASE_DIR = Path(__file__).parent
PORT     = 7474

# Job tracking — stores running/completed agent jobs
jobs = {}  # job_id -> { status, output, started_at, finished_at }


class IntelHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Clean up default HTTP server logging
        print(f"[local_server] {args[0]} {args[1]}")

    def do_OPTIONS(self):
        # Handle CORS preflight from browser
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length  = int(self.headers.get('Content-Length', 0))
        body    = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception:
            self._respond(400, {'error': 'Bad JSON'})
            return

        path = self.path

        if path == '/run-agent':
            mode   = data.get('mode', 'diagnostic')
            reason = data.get('reason', 'Intel command')
            self._run_agent(mode, reason)

        elif path == '/job-status':
            job_id = data.get('job_id')
            if job_id and job_id in jobs:
                self._respond(200, jobs[job_id])
            else:
                self._respond(404, {'error': 'Job not found'})

        elif path == '/stop':
            # Mark all running jobs as stopped
            for jid in jobs:
                if jobs[jid]['status'] == 'running':
                    jobs[jid]['status'] = 'stopped'
            self._respond(200, {'status': 'stopped'})

        elif path == '/notify':
            level   = data.get('level', 'warn')
            tool    = data.get('tool', 'AI Tool')
            data_kb = data.get('data_kb')
            self._notify(level, tool, data_kb)

        elif path == '/status':
            self._respond(200, {
                'shield': 'online',
                'machine': platform.node(),
                'os': platform.system() + ' ' + platform.release(),
                'agent_ready': (BASE_DIR / 'agent.py').exists(),
            })

        else:
            self._respond(404, {'error': 'Not found'})

    def do_GET(self):
        if self.path == '/ping':
            self._respond(200, {'status': 'ok', 'machine': platform.node()})
        else:
            self._respond(404, {'error': 'Not found'})

    # ── Handlers ──────────────────────────────────────────────────────────────

    def _run_agent(self, mode, reason):
        agent_path = BASE_DIR / 'agent.py'
        if not agent_path.exists():
            self._respond(500, {'error': 'agent.py not found in Syphir_box'})
            return

        # Create job entry
        job_id = str(int(time.time() * 1000))
        jobs[job_id] = {
            'status':      'running',
            'mode':        mode,
            'started_at':  time.time(),
            'finished_at': None,
            'summary':     None,
        }

        print(f"[local_server] Dispatching agent mode={mode} job={job_id}")

        # Run agent in background thread so we can track completion
        def run_and_track():
            import shutil, tempfile

            # Copy agent to temp so original is never deleted
            tmp = tempfile.NamedTemporaryFile(
                suffix='_syphir_agent.py', delete=False, dir='/tmp'
            )
            tmp.close()
            shutil.copy2(str(agent_path), tmp.name)

            incident_payload = json.dumps({
                'reason':        reason,
                'tool':          'Intel Command',
                'bytes_kb':      '0',
                'mode':          mode,
                'dispatch_type': 'admin_initiated',
            })

            # Open terminal window (visual only — employee sees live output)
            open_terminal_with_agent(tmp.name, incident_payload, job_id)

            # Wait for the terminal process to finish by watching the temp file
            # The agent self-deletes when done — so we poll for file deletion
            import time as _time
            waited = 0
            while os.path.exists(tmp.name) and waited < 180:
                _time.sleep(1)
                waited += 1

            # File gone = agent done (self-deleted), or timeout
            jobs[job_id]['status']      = 'done'
            jobs[job_id]['finished_at'] = _time.time()
            jobs[job_id]['summary']     = f"{mode.capitalize()} complete on this machine."

            # Clean up if still there (timeout case)
            try:
                if os.path.exists(tmp.name):
                    os.remove(tmp.name)
            except Exception:
                pass

            print(f"[local_server] Job {job_id} finished — status={jobs[job_id]['status']}")

        threading.Thread(target=run_and_track, daemon=True).start()

        if True:  # always respond immediately
            self._respond(200, {'status': 'dispatched', 'mode': mode, 'job_id': job_id})

    def _notify(self, level, tool, data_kb):
        notifier_path = BASE_DIR / 'notifier.py'
        if not notifier_path.exists():
            self._respond(500, {'error': 'notifier.py not found'})
            return

        payload = json.dumps({'level': level, 'tool': tool, 'data_kb': data_kb})
        try:
            subprocess.Popen(
                ['python3', str(notifier_path), payload],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            self._respond(200, {'status': 'notification sent'})
        except Exception as e:
            self._respond(500, {'error': str(e)})

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')


# ── Terminal launcher ─────────────────────────────────────────────────────────

def open_terminal_with_agent(agent_path, incident_json, job_id=None):
    """
    Opens a new terminal window and runs agent.py in it.
    Platform-aware: Mac uses Terminal.app, Windows uses cmd, Linux uses bash.
    """
    system = platform.system()

    # Escape the JSON for shell
    safe_json = incident_json.replace("'", '"').replace('"', '\\"')

    if system == 'Darwin':
        # Mac: open a new Terminal window, run agent, then close window when done
        script = f'''
        tell application "Terminal"
            activate
            set w to do script "cd '{Path(agent_path).parent}' && python3 '{agent_path}' '{safe_json}'; exit"
        end tell
        '''
        try:
            subprocess.Popen(['osascript', '-e', script])
            return True
        except Exception as e:
            print(f"[local_server] AppleScript failed: {e}")
            return False

    elif system == 'Windows':
        # /C closes automatically when done, /K keeps it open — use /C
        cmd = f'start cmd /C "cd /d {Path(agent_path).parent} && python3 {agent_path} \\"{safe_json}\\""'
        try:
            subprocess.Popen(cmd, shell=True)
            return True
        except Exception as e:
            print(f"[local_server] Windows terminal failed: {e}")
            return False

    elif system == 'Linux':
        # Try common Linux terminals in order
        terminals = ['gnome-terminal', 'xterm', 'konsole', 'xfce4-terminal']
        cmd       = f"python3 '{agent_path}' '{safe_json}'"
        for term in terminals:
            try:
                subprocess.Popen([term, '--', 'bash', '-c', cmd])
                return True
            except FileNotFoundError:
                continue
        print("[local_server] No Linux terminal found")
        return False

    else:
        print(f"[local_server] Unknown OS: {system}")
        return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print()
    print("=" * 48)
    print("  Syphir Shield — Local Bridge Server")
    print("=" * 48)
    print(f"  Listening on http://localhost:{PORT}")
    print(f"  Machine : {platform.node()}")
    print(f"  OS      : {platform.system()} {platform.release()}")
    print(f"  Agent   : {'FOUND' if (BASE_DIR / 'agent.py').exists() else 'NOT FOUND'}")
    print()
    print("  Keep this running while using Intel in the dashboard.")
    print("  Ctrl+C to stop.")
    print("=" * 48)
    print()

    server = HTTPServer(('localhost', PORT), IntelHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[local_server] Stopped.")
        server.server_close()


if __name__ == '__main__':
    main()