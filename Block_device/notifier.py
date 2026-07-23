"""
Syphir Shield — notifier.py
Sends native OS notifications to employee machines.
Mac gets a macOS notification, Windows gets a toast,
Linux gets a desktop notification.
Runs locally on the employee machine — triggered via SSH from the box.
"""

import os
import sys
import json
import time
import platform
import subprocess
from datetime import datetime
from pathlib import Path


# Notification levels
LEVELS = {
    'info':     {'title': 'Syphir Shield',          'sound': True},
    'warn':     {'title': 'Syphir — Data Alert',    'sound': True},
    'critical': {'title': 'Syphir — Action Needed', 'sound': True},
}

# How long notification stays on screen (seconds)
DISPLAY_DURATION = 8


# ── Platform handlers ─────────────────────────────────────────────────────────

def notify_mac(title, message, subtitle=None, url=None):
    """
    macOS notification via osascript.
    Shows in top-right corner, respects Do Not Disturb.
    """
    subtitle_line = f'subtitle "{subtitle}"' if subtitle else ''
    sound_line    = 'sound name "Funk"'

    script = f'''
    display notification "{message}" \\
        with title "{title}" \\
        {subtitle_line} \\
        {sound_line}
    '''

    try:
        subprocess.run(
            ['osascript', '-e', script],
            capture_output=True, timeout=10
        )
        return True
    except Exception as e:
        print(f"[notifier] macOS notify failed: {e}")
        return False


def notify_windows(title, message, level='info'):
    """
    Windows 10/11 toast notification via PowerShell.
    Shows in bottom-right corner action center.
    """
    # Map level to Windows notification icon
    icon_map = {
        'info':     'Info',
        'warn':     'Warning',
        'critical': 'Error',
    }
    icon = icon_map.get(level, 'Info')

    ps_script = f"""
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
    $xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('{title}')) | Out-Null
    $xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('{message}')) | Out-Null

    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Syphir Shield')
    $notifier.Show($toast)
    """

    try:
        subprocess.run(
            ['powershell', '-Command', ps_script],
            capture_output=True, timeout=15
        )
        return True
    except Exception as e:
        # Fallback: simpler msg box
        try:
            simple = f'powershell -Command "Add-Type -AssemblyName PresentationFramework;[System.Windows.MessageBox]::Show(\'{message}\',\'{title}\')"'
            subprocess.run(simple, shell=True, timeout=10)
            return True
        except Exception:
            print(f"[notifier] Windows notify failed: {e}")
            return False


def notify_linux(title, message, level='info'):
    """
    Linux desktop notification via notify-send.
    Works on GNOME, KDE, XFCE.
    """
    urgency_map = {'info': 'low', 'warn': 'normal', 'critical': 'critical'}
    urgency     = urgency_map.get(level, 'normal')

    try:
        subprocess.run(
            ['notify-send',
             '--urgency', urgency,
             '--expire-time', str(DISPLAY_DURATION * 1000),
             '--icon', 'dialog-warning',
             title, message],
            capture_output=True, timeout=10
        )
        return True
    except FileNotFoundError:
        # notify-send not installed — try zenity as fallback
        try:
            subprocess.run(
                ['zenity', '--notification', f'--text={title}: {message}'],
                capture_output=True, timeout=10
            )
            return True
        except Exception as e:
            print(f"[notifier] Linux notify failed: {e}")
            return False


# ── Message templates ─────────────────────────────────────────────────────────

def build_message(level, tool, data_kb=None, reason=None):
    """
    Builds the notification message shown to the employee.
    Informative, not alarming. Tells them what happened, not that they're in trouble.
    """
    if level == 'warn':
        if data_kb:
            return (
                f"You've sent {data_kb}KB to {tool}. "
                f"If this includes sensitive client data, consider what was shared."
            )
        return f"Elevated activity detected on {tool}. Your IT team has been notified."

    if level == 'critical':
        if data_kb:
            return (
                f"High data volume ({data_kb}KB) detected going to {tool}. "
                f"Your IT administrator has been notified."
            )
        return f"Unusual activity on {tool} has been flagged. Please check with your IT team."

    if level == 'info':
        return reason or f"Syphir Shield is monitoring your {tool} activity."

    return reason or "Syphir Shield notification."


# ── Main push function ────────────────────────────────────────────────────────

def push(level, tool, data_kb=None, reason=None, report_url=None):
    """
    Main entry point. Detects OS and fires the right notification.
    Called locally on the employee machine after the box SSH's in.

    Args:
        level      : 'info' | 'warn' | 'critical'
        tool       : AI tool name e.g. 'Claude', 'ChatGPT'
        data_kb    : KB of data sent (shown in message)
        reason     : Custom message override
        report_url : URL to open when employee clicks (future)
    """
    cfg     = LEVELS.get(level, LEVELS['info'])
    title   = cfg['title']
    message = build_message(level, tool, data_kb, reason)
    os_name = platform.system()

    print(f"[notifier] Sending {level} notification on {os_name}")
    print(f"[notifier] Title  : {title}")
    print(f"[notifier] Message: {message}")

    if os_name == 'Darwin':
        success = notify_mac(title, message, subtitle=f"via {tool}")
    elif os_name == 'Windows':
        success = notify_windows(title, message, level)
    elif os_name == 'Linux':
        success = notify_linux(title, message, level)
    else:
        print(f"[notifier] Unknown OS: {os_name} — skipping notification")
        success = False

    if success:
        print(f"[notifier] Notification delivered at {datetime.now().strftime('%H:%M:%S')}")
    else:
        print(f"[notifier] Notification failed — employee may not have seen it")

    return success


# ── SSH dispatch helper (runs on the BOX, not the employee machine) ───────────

def dispatch_via_ssh(employee_ip, employee_user, level, tool, data_kb=None, key_path=None):
    """
    Called by server.py on the Pi.
    SSH's into the employee's machine and runs notifier.py there.
    The notifier then fires the native OS notification locally.

    Needs the Pi hardware to actually send — stubbed here for pre-hardware build.
    """
    notifier_path = Path(__file__).resolve()

    # Build the payload to pass to the remote notifier
    payload = json.dumps({
        'level':   level,
        'tool':    tool,
        'data_kb': data_kb,
    })

    # SSH command that copies and runs notifier on employee machine
    ssh_cmd = [
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
    ]
    if key_path:
        ssh_cmd += ['-i', key_path]

    ssh_cmd += [
        f"{employee_user}@{employee_ip}",
        f"python3 /tmp/syphir_notifier.py '{payload}' && rm -f /tmp/syphir_notifier.py"
    ]

    # First SCP the notifier to the machine
    scp_cmd = ['scp']
    if key_path:
        scp_cmd += ['-i', key_path]
    scp_cmd += [
        '-o', 'StrictHostKeyChecking=no',
        str(notifier_path),
        f"{employee_user}@{employee_ip}:/tmp/syphir_notifier.py"
    ]

    print(f"[notifier] Dispatching to {employee_user}@{employee_ip}")

    # NOTE: These actually run when the Pi hardware is present
    # For now they print what they would do
    print(f"[notifier] Would SCP : {' '.join(scp_cmd)}")
    print(f"[notifier] Would SSH : {' '.join(ssh_cmd)}")
    print(f"[notifier] (SSH dispatch requires Pi hardware — stubbed for pre-hardware build)")

    return True


# ── Entry point (runs on employee machine after SSH dispatch) ─────────────────

if __name__ == '__main__':
    # Called with JSON payload as argv[1] when dispatched via SSH
    # e.g. python3 notifier.py '{"level":"warn","tool":"Claude","data_kb":45}'
    if len(sys.argv) > 1:
        try:
            payload = json.loads(sys.argv[1])
            push(
                level   = payload.get('level', 'warn'),
                tool    = payload.get('tool', 'AI Tool'),
                data_kb = payload.get('data_kb'),
                reason  = payload.get('reason'),
            )
        except json.JSONDecodeError as e:
            print(f"[notifier] Bad payload: {e}")
            sys.exit(1)
    else:
        # Standalone test — fire a test notification on this machine
        print("[notifier] Running test notification...")
        push(
            level   = 'warn',
            tool    = 'Claude',
            data_kb = 45,
        )