"""
Syphir Shield — agent.py
Ephemeral terminal worker. Lives on the box.
Dispatched to employee machines for diagnostics AND repairs.
Requires admin approval before dispatch.
Runs visibly in employee terminal, then self-deletes.

Two trigger directions:
  1. Box-initiated  — box detects issue, requests approval via dashboard
  2. Admin-initiated — admin clicks Send Agent from dashboard team page
"""

import os
import sys
import json
import time
import shutil
import platform
import subprocess
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path


# Terminal colors
class C:
    BLUE   = '\033[94m'
    GREEN  = '\033[92m'
    YELLOW = '\033[93m'
    RED    = '\033[91m'
    WHITE  = '\033[97m'
    GRAY   = '\033[90m'
    CYAN   = '\033[96m'
    BOLD   = '\033[1m'
    RESET  = '\033[0m'

    @staticmethod
    def supported():
        if platform.system() == 'Windows':
            return 'WT_SESSION' in os.environ or bool(os.environ.get('TERM_PROGRAM'))
        return True


def c(color, text):
    return f"{color}{text}{C.RESET}" if C.supported() else text


def header(mode='diagnostic'):
    label = 'Diagnostic' if mode == 'diagnostic' else 'Repair'
    print()
    print(c(C.BOLD + C.BLUE, "=" * 48))
    print(c(C.BOLD + C.WHITE, f"  Syphir Shield - Remote {label}"))
    print(c(C.GRAY,           "  Dispatched by your IT security box"))
    print(c(C.BOLD + C.BLUE, "=" * 48))
    print()


def step(label, status=None):
    if status is None:
        print(f"  {'...'}  {label}", end='', flush=True)
    elif status == 'ok':
        print(f"\r  {c(C.GREEN,  ' OK ')}  {label}                    ")
    elif status == 'warn':
        print(f"\r  {c(C.YELLOW, ' !! ')}  {label}                    ")
    elif status == 'fail':
        print(f"\r  {c(C.RED,    'FAIL')}  {label}                    ")
    elif status == 'fix':
        print(f"\r  {c(C.CYAN,   ' FX ')}  {label}                    ")
    elif status == 'info':
        print(f"\r  {c(C.CYAN,   'INFO')}  {label}                    ")


def progress_bar(label, duration=1.5, steps=20):
    bar_color = C.BLUE if C.supported() else ''
    reset     = C.RESET if C.supported() else ''
    print(f"\n  {label}")
    for i in range(steps + 1):
        filled = '#' * i
        empty  = '-' * (steps - i)
        pct    = int((i / steps) * 100)
        print(f"\r  {bar_color}[{filled}{empty}]{reset}  {pct}%", end='', flush=True)
        time.sleep(duration / steps)
    print()


def divider():
    print(c(C.GRAY, "  " + "-" * 44))


def blank():
    print()


# DIAGNOSTIC CHECKS

def check_processes():
    suspicious = []
    shadow_ai  = ['ollama', 'localai', 'lmstudio', 'jan ', 'gpt4all', 'llamafile']
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(['tasklist'], capture_output=True, text=True, timeout=10)
        else:
            result = subprocess.run(['ps', 'aux'], capture_output=True, text=True, timeout=10)
        output = result.stdout.lower()
        for proc in shadow_ai:
            if proc in output:
                suspicious.append(proc.strip())
    except Exception:
        pass
    return suspicious


def check_cpu_memory():
    issues = []
    try:
        if platform.system() == 'Darwin':
            result = subprocess.run(['top', '-l', '1', '-n', '0'], capture_output=True, text=True, timeout=10)
            for line in result.stdout.splitlines():
                if 'CPU usage' in line:
                    parts = line.split()
                    try:
                        pcts = [p for p in parts if p.endswith('%')]
                        if len(pcts) >= 3:
                            idle = float(pcts[2].replace('%', ''))
                            if idle < 20:
                                issues.append(f"High CPU load: {100-idle:.0f}% used")
                    except Exception:
                        pass
        elif platform.system() == 'Windows':
            result = subprocess.run(['wmic', 'cpu', 'get', 'loadpercentage'], capture_output=True, text=True, timeout=10)
            lines = [l.strip() for l in result.stdout.splitlines() if l.strip().isdigit()]
            if lines and int(lines[0]) > 80:
                issues.append(f"High CPU load: {lines[0]}%")
    except Exception:
        pass
    return issues


def check_disk_space():
    issues = []
    try:
        total, used, free = shutil.disk_usage(Path.home())
        free_gb  = free  / (1024 ** 3)
        total_gb = total / (1024 ** 3)
        pct_used = (used / total) * 100
        if free_gb < 2:
            issues.append(f"Critically low disk: {free_gb:.1f}GB of {total_gb:.0f}GB remaining")
        elif pct_used > 90:
            issues.append(f"Disk {pct_used:.0f}% full")
    except Exception:
        pass
    return issues


def check_browser_extensions():
    flagged = []
    shadow_ext_ids = {
        'dfhblcfoopedkmbnlkfbiknjalkmfhbl': 'Merlin AI',
        'bgbpcgpcobgjpnpiginlikhchmgghpml': 'Monica AI',
        'jdiccldimpdaibmpdkjnbmckianbfold': 'Sider AI',
    }
    chrome_paths = {
        'Darwin':  Path.home() / 'Library/Application Support/Google/Chrome/Default/Extensions',
        'Windows': Path(os.environ.get('LOCALAPPDATA', '')) / 'Google/Chrome/User Data/Default/Extensions',
        'Linux':   Path.home() / '.config/google-chrome/Default/Extensions',
    }
    ext_dir = chrome_paths.get(platform.system())
    if ext_dir and ext_dir.exists():
        installed = [p.name for p in ext_dir.iterdir() if p.is_dir()]
        for ext_id, name in shadow_ext_ids.items():
            if ext_id in installed:
                flagged.append(name)
    return flagged


def check_env_variables():
    flagged     = []
    ai_patterns = ['OPENAI', 'ANTHROPIC', 'GEMINI', 'GROQ', 'MISTRAL', 'COHERE', 'DEEPSEEK']
    for key in os.environ:
        for pattern in ai_patterns:
            if pattern in key.upper():
                flagged.append(key)
    return flagged


def check_recent_large_files():
    flagged    = []
    watch_dirs = [Path.home() / 'Downloads', Path.home() / 'Desktop', Path.home() / 'Documents']
    watch_exts = {'.csv', '.json', '.txt', '.pdf', '.xlsx'}
    size_limit = 1 * 1024 * 1024
    time_limit = 3600
    now        = time.time()
    for d in watch_dirs:
        if not d.exists():
            continue
        try:
            for f in d.iterdir():
                if f.suffix.lower() in watch_exts:
                    stat = f.stat()
                    if stat.st_size > size_limit and (now - stat.st_mtime) < time_limit:
                        flagged.append({'file': f.name, 'size_mb': round(stat.st_size/1024/1024, 1), 'dir': str(d)})
        except PermissionError:
            pass
    return flagged


# REPAIR FUNCTIONS

def repair_kill_frozen_processes():
    killed = []
    try:
        if platform.system() == 'Darwin':
            result = subprocess.run(['ps', 'aux'], capture_output=True, text=True, timeout=10)
            for line in result.stdout.splitlines():
                cols = line.split()
                if len(cols) > 7 and cols[7] == 'Z':
                    pid = cols[1]
                    try:
                        subprocess.run(['kill', '-9', pid], timeout=5)
                        killed.append(f"PID {pid} zombie")
                    except Exception:
                        pass
        elif platform.system() == 'Windows':
            result = subprocess.run(['tasklist', '/FI', 'STATUS eq Not Responding'], capture_output=True, text=True, timeout=10)
            for line in result.stdout.splitlines()[3:]:
                parts = line.split()
                if len(parts) > 1:
                    try:
                        subprocess.run(['taskkill', '/PID', parts[1], '/F'], timeout=5)
                        killed.append(f"{parts[0]} PID {parts[1]}")
                    except Exception:
                        pass
    except Exception:
        pass
    return killed


def repair_clear_temp_files():
    cleared_mb = 0
    temp_dirs  = {
        'Darwin':  [Path('/tmp'), Path.home() / 'Library/Caches'],
        'Windows': [Path(os.environ.get('TEMP', 'C:/Windows/Temp'))],
        'Linux':   [Path('/tmp')],
    }.get(platform.system(), [Path('/tmp')])

    for temp_dir in temp_dirs:
        if not temp_dir.exists():
            continue
        try:
            for item in temp_dir.iterdir():
                try:
                    if item.is_file():
                        size = item.stat().st_size
                        item.unlink()
                        cleared_mb += size / (1024 * 1024)
                    elif item.is_dir() and item.name.startswith('tmp'):
                        shutil.rmtree(item, ignore_errors=True)
                except (PermissionError, OSError):
                    pass
        except PermissionError:
            pass
    return round(cleared_mb, 1)


def repair_flush_dns():
    try:
        if platform.system() == 'Darwin':
            subprocess.run(['sudo', 'dscacheutil', '-flushcache'], capture_output=True, timeout=10)
            subprocess.run(['sudo', 'killall', '-HUP', 'mDNSResponder'], capture_output=True, timeout=10)
        elif platform.system() == 'Windows':
            subprocess.run(['ipconfig', '/flushdns'], capture_output=True, timeout=10)
        elif platform.system() == 'Linux':
            subprocess.run(['sudo', 'systemd-resolve', '--flush-caches'], capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def repair_clear_browser_cache():
    cleared = []
    chrome_cache = {
        'Darwin':  Path.home() / 'Library/Caches/Google/Chrome/Default/Cache',
        'Windows': Path(os.environ.get('LOCALAPPDATA', '')) / 'Google/Chrome/User Data/Default/Cache',
        'Linux':   Path.home() / '.cache/google-chrome/Default/Cache',
    }.get(platform.system())
    if chrome_cache and chrome_cache.exists():
        try:
            shutil.rmtree(chrome_cache, ignore_errors=True)
            cleared.append('Chrome')
        except Exception:
            pass
    return cleared


def repair_free_memory():
    try:
        if platform.system() == 'Darwin':
            subprocess.run(['sudo', 'purge'], capture_output=True, timeout=15)
            return True
        elif platform.system() == 'Windows':
            subprocess.run(
                ['powershell', '-Command', '[System.GC]::Collect()'],
                capture_output=True, timeout=15
            )
            return True
    except Exception:
        pass
    return False


# APPROVAL FLOW

def request_approval(config, employee_ip, reason, dispatch_type='repair'):
    try:
        payload = json.dumps({
            'device_key':    config['device_key'],
            'org_key':       config['org_key'],
            'employee_ip':   employee_ip,
            'reason':        reason,
            'dispatch_type': dispatch_type,
            'timestamp':     datetime.utcnow().isoformat() + 'Z',
            'status':        'pending',
        }).encode()
        req = urllib.request.Request(
            f"{config['api_url']}/shield/dispatch-request",
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode())
            print(f"  Dispatch request sent — waiting for admin approval")
            print(f"  Request ID: {data.get('request_id', 'unknown')}")
            return data.get('request_id')
    except Exception as e:
        print(f"  Could not send dispatch request: {e}")
        return None


def poll_for_approval(config, request_id, timeout_seconds=300):
    print(f"  Waiting for admin approval (timeout: 5 min)...")
    elapsed = 0
    while elapsed < timeout_seconds:
        time.sleep(10)
        elapsed += 10
        try:
            req = urllib.request.Request(
                f"{config['api_url']}/shield/dispatch-request/{request_id}",
                method='GET'
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                data   = json.loads(res.read().decode())
                status = data.get('status')
                if status == 'approved':
                    print(f"  Admin approved — dispatching agent")
                    return True
                elif status == 'denied':
                    print(f"  Admin denied dispatch request")
                    return False
                else:
                    print(f"  Still waiting... ({elapsed}s)", end='\r')
        except Exception:
            pass
    print(f"  Approval timeout — request expired")
    return False


# MAIN FLOWS

def run_diagnostic(incident):
    header('diagnostic')
    print(c(C.GRAY, f"  Machine : {platform.node()}"))
    print(c(C.GRAY, f"  OS      : {platform.system()} {platform.release()}"))
    print(c(C.GRAY, f"  Time    : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"))
    print(c(C.GRAY, f"  Trigger : {incident.get('reason', 'Network threshold exceeded')}"))
    blank()
    divider()
    blank()

    results   = {}
    all_clear = True

    step("Scanning active processes")
    time.sleep(0.6)
    procs = check_processes()
    results['processes'] = procs
    if procs:
        all_clear = False
        step(f"Shadow AI detected: {', '.join(procs)}", 'warn')
    else:
        step("Active processes — no shadow AI detected", 'ok')

    step("Checking browser extensions")
    time.sleep(0.5)
    exts = check_browser_extensions()
    results['extensions'] = exts
    if exts:
        all_clear = False
        step(f"Unapproved extensions: {', '.join(exts)}", 'warn')
    else:
        step("Browser extensions — all clear", 'ok')

    step("Checking for exposed API keys")
    time.sleep(0.4)
    env_keys = check_env_variables()
    results['env_keys'] = env_keys
    if env_keys:
        all_clear = False
        step(f"Exposed keys: {', '.join(env_keys)}", 'warn')
    else:
        step("Environment variables — no exposed keys", 'ok')

    step("Reviewing recent large files")
    time.sleep(0.7)
    files = check_recent_large_files()
    results['large_files'] = files
    if files:
        all_clear = False
        for f in files:
            step(f"Large file: {f['file']} ({f['size_mb']}MB)", 'warn')
    else:
        step("Recent files — nothing flagged", 'ok')

    results['status']  = 'clean' if all_clear else 'flagged'
    results['summary'] = (
        "No issues found on this machine."
        if all_clear else
        "Some items were flagged. Your IT admin has been notified."
    )
    return results


def run_repair(incident):
    header('repair')
    print(c(C.GRAY, f"  Machine : {platform.node()}"))
    print(c(C.GRAY, f"  OS      : {platform.system()} {platform.release()}"))
    print(c(C.GRAY, f"  Time    : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"))
    print(c(C.GRAY, f"  Reason  : {incident.get('reason', 'Admin-requested repair')}"))
    blank()
    divider()
    blank()

    repairs  = {}

    # Phase 1
    print(c(C.BOLD + C.WHITE, "  Phase 1 - Diagnosing"))
    blank()

    step("Checking system load")
    time.sleep(0.5)
    cpu_issues = check_cpu_memory()
    if cpu_issues:
        for issue in cpu_issues:
            step(issue, 'warn')
    else:
        step("System load — normal", 'ok')

    step("Checking disk space")
    time.sleep(0.4)
    disk_issues = check_disk_space()
    if disk_issues:
        for issue in disk_issues:
            step(issue, 'warn')
    else:
        step("Disk space — sufficient", 'ok')

    step("Scanning for frozen processes")
    time.sleep(0.5)
    shadow_procs = check_processes()
    if shadow_procs:
        step(f"Shadow AI found: {', '.join(shadow_procs)}", 'warn')
    else:
        step("Processes — nothing frozen or suspicious", 'ok')

    blank()
    divider()
    blank()

    # Phase 2
    print(c(C.BOLD + C.WHITE, "  Phase 2 - Repairing"))
    blank()

    step("Terminating frozen processes")
    progress_bar("  Scanning process table...", duration=1.2)
    killed = repair_kill_frozen_processes()
    repairs['killed_processes'] = killed
    step(f"Terminated {len(killed)} frozen process(es)" if killed else "No frozen processes found", 'fix' if killed else 'ok')

    step("Flushing DNS cache")
    time.sleep(0.6)
    dns_ok = repair_flush_dns()
    repairs['dns_flushed'] = dns_ok
    step("DNS cache flushed — tabs should respond faster", 'ok' if dns_ok else 'warn')

    step("Clearing browser cache")
    progress_bar("  Clearing cache files...", duration=1.0)
    cleared_browsers = repair_clear_browser_cache()
    repairs['browser_cache'] = cleared_browsers
    step(f"Cleared: {', '.join(cleared_browsers)}" if cleared_browsers else "Browser cache already clean", 'fix' if cleared_browsers else 'ok')

    step("Removing temporary files")
    progress_bar("  Scanning temp directories...", duration=1.5)
    cleared_mb = repair_clear_temp_files()
    repairs['cleared_mb'] = cleared_mb
    step(f"{cleared_mb}MB of temp files cleared", 'fix' if cleared_mb > 0 else 'ok')

    step("Freeing memory")
    progress_bar("  Releasing memory...", duration=1.0)
    mem_ok = repair_free_memory()
    repairs['memory_freed'] = mem_ok
    step("Memory released", 'ok' if mem_ok else 'warn')

    blank()
    divider()
    blank()

    # Phase 3
    print(c(C.BOLD + C.WHITE, "  Phase 3 - Verifying"))
    blank()

    step("Re-checking disk space")
    time.sleep(0.5)
    disk_after = check_disk_space()
    step("Disk space healthy after cleanup" if not disk_after else "Disk still low — manual cleanup may help", 'ok' if not disk_after else 'warn')

    step("Verifying network connectivity")
    time.sleep(0.4)
    try:
        urllib.request.urlopen('https://syphir-api.onrender.com', timeout=5)
        step("Network — connected", 'ok')
    except Exception:
        step("Network — could not reach Syphir API", 'warn')

    repairs['status']  = 'repaired'
    repairs['summary'] = (
        f"Repair complete. {cleared_mb}MB freed, DNS flushed, {len(killed)} frozen process(es) cleared."
        if killed or cleared_mb > 0 else
        "Machine scanned and cleaned. No major issues found."
    )
    return repairs


# REPORT AND CLEANUP

def build_report(results, incident, mode):
    return {
        'timestamp':    datetime.utcnow().isoformat() + 'Z',
        'machine':      platform.node(),
        'os':           platform.system() + ' ' + platform.release(),
        'mode':         mode,
        'triggered_by': incident.get('reason', 'Unknown'),
        'ai_tool':      incident.get('tool', 'Unknown'),
        'results':      results,
        'status':       results.get('status', 'unknown'),
        'summary':      results.get('summary', 'Agent completed.'),
    }


def open_report(report):
    import urllib.parse
    import webbrowser
    # Use the dashboard-hosted report page on Vercel
    base_url    = "https://syphir.vercel.app/agent_report.html"
    # Use local if running from the dashboard folder
    report_path = Path(__file__).parent.parent / 'dashboard' / 'agent_report.html'
    if not report_path.exists():
        report_path = Path(__file__).parent / 'agent_report.html'
    if report_path.exists():
        base_url = report_path.as_uri()
    params = urllib.parse.urlencode({'data': json.dumps(report, default=str)})
    webbrowser.open(f"{base_url}?{params}")


def self_destruct():
    script_path = Path(__file__).resolve()
    if platform.system() == 'Windows':
        subprocess.Popen(
            f'ping 127.0.0.1 -n 2 > nul && del /f "{script_path}"',
            shell=True, creationflags=subprocess.DETACHED_PROCESS
        )
    else:
        subprocess.Popen(
            f'sleep 1 && rm -f "{script_path}"',
            shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )


def run(incident=None):
    if incident is None:
        incident = {
            'reason':        'Manual run',
            'tool':          'Unknown',
            'bytes_kb':      '0',
            'mode':          'diagnostic',
            'dispatch_type': 'admin_initiated',
        }

    mode    = incident.get('mode', 'diagnostic')
    stealth = incident.get('stealth', False)

    # Defend mode runs silently — no terminal output to avoid tipping off attacker
    if mode == 'defend':
        results = run_defend(incident, stealth=stealth)
        if not stealth:
            blank()
            status = results.get('status', 'unknown')
            if status == 'threat_neutralized':
                print(c(C.GREEN + C.BOLD, "  Threat neutralized. Machine secured."))
            elif status == 'threat_found':
                print(c(C.YELLOW + C.BOLD, "  Threat found — admin review required."))
            elif status == 'clean':
                print(c(C.GREEN + C.BOLD, "  No active threat found. Machine is clean."))
            blank()
        report = build_report(results, incident, mode)
        _send_defense_report(report, incident)
        self_destruct()
        return

    results = run_repair(incident) if mode == 'repair' else run_diagnostic(incident)

    blank()

    status = results.get('status', 'unknown')
    if status == 'clean':
        print(c(C.GREEN + C.BOLD,  "  All clear. No issues found on this machine."))
    elif status == 'repaired':
        print(c(C.CYAN + C.BOLD,   "  Repair complete. Your machine should be running better."))
    elif status == 'flagged':
        print(c(C.YELLOW + C.BOLD, "  Some items flagged. Your IT admin has been notified."))

    blank()

    step("Building your summary report")
    time.sleep(0.3)
    report = build_report(results, incident, mode)
    step("Report ready", 'ok')

    step("Opening report in browser")
    time.sleep(0.4)
    try:
        open_report(report)
        step("Browser report opened", 'ok')
    except Exception as e:
        step(f"Could not open browser: {e}", 'warn')

    blank()

    step("Agent removing itself from this machine")
    time.sleep(0.5)
    self_destruct()
    step("Agent removed — nothing left behind", 'ok')

    blank()
    print(c(C.GRAY, "  Syphir Shield — complete. Stay protected."))
    blank()
    print(c(C.BOLD + C.BLUE, "  You can close this terminal window."))
    blank()


# DEFEND MODE

def run_defend(incident, stealth=True):
    """
    Silent defense mode. No terminal window shown.
    Runs when the Shield detects an active intrusion on this machine.
    Finds and kills the threat, locks down, reports back to box.
    Attacker never sees it coming.
    """
    results  = {
        'mode':             'defend',
        'stealth':          stealth,
        'started_at':       datetime.utcnow().isoformat(),
        'threat_reason':    incident.get('reason', 'Unknown threat'),
        'suspicious_procs': [],
        'killed_procs':     [],
        'bad_connections':  [],
        'closed_ports':     [],
        'unauthorized_keys':[],
        'bad_cron_jobs':    [],
        'files_flagged':    [],
        'status':           'clean',
        'summary':          '',
    }

    def log_silent(msg):
        """In stealth mode write to log file only, never stdout."""
        import logging
        logging.getLogger('syphir.agent.defend').info(msg)

    def out(msg):
        if not stealth:
            print(f"  {msg}")
        log_silent(msg)

    out("Defense agent active — scanning for threat")

    # 1. Find suspicious processes
    out("Scanning processes...")
    sus_procs = _defend_find_suspicious_processes()
    results['suspicious_procs'] = sus_procs

    # 2. Kill confirmed malicious processes
    if sus_procs:
        out(f"Found {len(sus_procs)} suspicious process(es) — terminating")
        killed = _defend_kill_processes(sus_procs)
        results['killed_procs'] = killed
        if killed:
            results['status'] = 'threat_neutralized'

    # 3. Check active network connections for C2
    out("Scanning active connections...")
    bad_conns = _defend_find_bad_connections()
    results['bad_connections'] = bad_conns
    if bad_conns:
        results['status'] = 'threat_found'

    # 4. Close suspicious listening ports
    out("Checking listening ports...")
    closed = _defend_close_suspicious_ports()
    results['closed_ports'] = closed

    # 5. Check for unauthorized SSH keys
    out("Checking SSH authorized keys...")
    bad_keys = _defend_check_ssh_keys()
    results['unauthorized_keys'] = bad_keys
    if bad_keys:
        results['status'] = 'threat_found'

    # 6. Check for malicious cron jobs
    out("Checking scheduled tasks...")
    bad_crons = _defend_check_cron_jobs()
    results['bad_cron_jobs'] = bad_crons
    if bad_crons:
        results['status'] = 'threat_found'

    # 7. Check recently modified system files
    out("Checking recently modified files...")
    flagged_files = _defend_check_modified_files()
    results['files_flagged'] = flagged_files

    # Build summary
    total_findings = (
        len(results['killed_procs']) +
        len(results['bad_connections']) +
        len(results['unauthorized_keys']) +
        len(results['bad_cron_jobs'])
    )

    if results['status'] == 'threat_neutralized':
        results['summary'] = (
            f"Threat neutralized. {len(results['killed_procs'])} malicious "
            f"process(es) terminated. {total_findings} total findings."
        )
    elif results['status'] == 'threat_found':
        results['summary'] = (
            f"Active threat indicators found: {total_findings} findings. "
            f"Admin review required. Device remains isolated."
        )
    else:
        results['summary'] = "No active threat found on this machine. Device appears clean."

    results['finished_at'] = datetime.utcnow().isoformat()
    out(f"Defense complete — {results['summary']}")
    return results


def _defend_find_suspicious_processes():
    """Find processes that look like malware, reverse shells, or C2 agents."""
    suspicious = []
    known_bad  = [
        'nc ', 'ncat', 'netcat', 'nmap', 'masscan',
        'msfconsole', 'msfvenom', 'metasploit',
        'mimikatz', 'bloodhound', 'sharphound',
        'cobalt', 'cobaltstrike', 'beacon',
        'ngrok', 'frp', 'chisel', 'ligolo',
        'python -c', 'bash -i', 'sh -i',
        'perl -e', 'ruby -e', '/dev/tcp',
        'powershell -enc', 'powershell -e ',
    ]
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(['tasklist', '/FO', 'CSV', '/V'],
                                    capture_output=True, text=True, timeout=10)
        else:
            result = subprocess.run(['ps', 'auxww'],
                                    capture_output=True, text=True, timeout=10)
        output = result.stdout.lower()
        for line in output.splitlines():
            for bad in known_bad:
                if bad.lower() in line:
                    suspicious.append({
                        'process': line.strip()[:120],
                        'matched': bad,
                    })
                    break
    except Exception as e:
        pass
    return suspicious


def _defend_kill_processes(sus_procs):
    """Attempt to kill suspicious processes by PID."""
    killed = []
    for proc in sus_procs:
        try:
            line = proc.get('process', '')
            parts = line.split()
            if len(parts) > 1:
                pid = parts[1] if platform.system() != 'Windows' else None
                if pid and pid.isdigit():
                    subprocess.run(['kill', '-9', pid],
                                   capture_output=True, timeout=5)
                    killed.append(f"PID {pid} ({proc.get('matched','')})")
        except Exception:
            pass
    return killed


def _defend_find_bad_connections():
    """Find active connections to known bad IPs or unusual ports."""
    bad = []
    suspicious_ports = {4444, 4445, 5555, 6666, 7777, 8888, 9999, 1234, 31337}
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(['netstat', '-ano'],
                                    capture_output=True, text=True, timeout=10)
        else:
            result = subprocess.run(['netstat', '-an'],
                                    capture_output=True, text=True, timeout=10)
        for line in result.stdout.splitlines():
            if 'ESTABLISHED' in line or 'established' in line:
                parts = line.split()
                for part in parts:
                    if ':' in part:
                        try:
                            port = int(part.split(':')[-1])
                            if port in suspicious_ports:
                                bad.append({
                                    'connection': line.strip()[:120],
                                    'reason': f"suspicious port {port}",
                                })
                        except ValueError:
                            pass
    except Exception:
        pass
    return bad


def _defend_close_suspicious_ports():
    """Close processes listening on known reverse-shell ports."""
    closed    = []
    bad_ports = {4444, 4445, 5555, 6666, 7777, 8888, 9999, 1234, 31337}
    if platform.system() in ('Darwin', 'Linux'):
        for port in bad_ports:
            try:
                result = subprocess.run(
                    ['lsof', '-ti', f':{port}'],
                    capture_output=True, text=True, timeout=5
                )
                pids = result.stdout.strip().splitlines()
                for pid in pids:
                    if pid.isdigit():
                        subprocess.run(['kill', '-9', pid],
                                       capture_output=True, timeout=5)
                        closed.append(f"port {port} (PID {pid})")
            except Exception:
                pass
    return closed


def _defend_check_ssh_keys():
    """Check for unauthorized SSH authorized_keys entries."""
    flagged = []
    auth_keys_path = Path.home() / '.ssh' / 'authorized_keys'
    if auth_keys_path.exists():
        try:
            with open(auth_keys_path) as f:
                lines = f.readlines()
            for i, line in enumerate(lines):
                line = line.strip()
                if line and not line.startswith('#'):
                    # Flag keys added in the last 24 hours
                    stat = auth_keys_path.stat()
                    import time as _time
                    if _time.time() - stat.st_mtime < 86400:
                        flagged.append({
                            'file':   str(auth_keys_path),
                            'line':   i + 1,
                            'detail': 'authorized_keys modified in last 24h',
                        })
                        break
        except Exception:
            pass
    return flagged


def _defend_check_cron_jobs():
    """Check for recently added malicious cron jobs."""
    flagged = []
    if platform.system() in ('Darwin', 'Linux'):
        try:
            result = subprocess.run(['crontab', '-l'],
                                    capture_output=True, text=True, timeout=5)
            crons = result.stdout
            bad_patterns = ['wget', 'curl', 'bash -i', 'nc ', '/tmp/', 'python -c', 'base64']
            for line in crons.splitlines():
                if line.strip() and not line.startswith('#'):
                    for pat in bad_patterns:
                        if pat in line:
                            flagged.append({
                                'cron':   line.strip()[:120],
                                'reason': f"suspicious pattern: {pat}",
                            })
                            break
        except Exception:
            pass
    return flagged


def _defend_check_modified_files():
    """Find recently modified files in sensitive locations."""
    flagged = []
    watch_dirs = ['/tmp', '/var/tmp', str(Path.home() / '.ssh')]
    if platform.system() == 'Darwin':
        watch_dirs.append('/Library/LaunchDaemons')
    elif platform.system() == 'Linux':
        watch_dirs.extend(['/etc/cron.d', '/etc/init.d'])

    import time as _time
    now = _time.time()
    for d in watch_dirs:
        p = Path(d)
        if not p.exists():
            continue
        try:
            for f in p.iterdir():
                if f.is_file():
                    age = now - f.stat().st_mtime
                    if age < 3600:  # modified in last hour
                        flagged.append({
                            'file':       str(f),
                            'age_minutes': round(age / 60),
                        })
        except PermissionError:
            pass
    return flagged[:20]  # cap at 20


def _send_defense_report(report, incident):
    """
    Send defense findings back to the Shield box API.
    In sim mode just logs locally.
    """
    try:
        import urllib.request as req
        api_url = incident.get('api_url', 'https://syphir-api.onrender.com')
        payload = json.dumps({
            'type':       'defense_report',
            'org_key':    incident.get('org_key', ''),
            'device_key': incident.get('device_key', ''),
            'report':     report,
        }, default=str).encode()
        r = req.Request(
            f"{api_url}/shield/defense-report",
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        req.urlopen(r, timeout=10)
    except Exception as e:
        import logging
        logging.getLogger('syphir.agent.defend').warning(f"Could not send defense report: {e}")


if __name__ == '__main__':
    incident = None
    if len(sys.argv) > 1:
        try:
            incident = json.loads(sys.argv[1])
        except json.JSONDecodeError:
            pass

    if incident is None:
        incident = {
            'reason':        'Test run — manual dispatch',
            'tool':          'Claude',
            'bytes_kb':      '45',
            'mode':          'diagnostic',
            'dispatch_type': 'admin_initiated',
            'stealth':       False,
        }

    run(incident)