#!/usr/bin/env python3
"""
Patches Block_device/reporter.py:
  1. org_key + device_key top-level fields -> single 'key' field
  2. adds 'message' field from verdict['reason']
  3. fixes POST endpoint /incidents -> /log-incident

Run this from the ROOT of the -syphir repo on your Mac:
    python3 patch_reporter.py

Then:
    git add Block_device/reporter.py
    git commit -m "fix: reporter.py auth field + endpoint"
    git push

Then on the Pi:
    ssh v1block@coopblock.local
    cd ~/-syphir && git pull
    cd Block_device && python3 reporter.py
"""

from pathlib import Path
import sys

TARGET = Path("Block_device/reporter.py")

EDITS = [
    (
        "        # Core fields (match Chrome extension schema exactly)\n"
        "        'id':           f\"inc_{uuid.uuid4().hex[:20]}\",\n"
        "        'org_key':      config['org_key'],\n"
        "        'device_key':   config['device_key'],\n"
        "        'source':       'network',              # tells dashboard: Shield, not browser\n"
        "        'risk_level':   risk_level,\n"
        "        'ai_tool':      tool['name'],\n"
        "        'user_email':   None,                   # filled in later when IP->employee mapping exists\n"
        "        'ip_address':   verdict['ip'],\n"
        "        'timestamp':    datetime.utcnow().isoformat() + 'Z',\n"
        "        'resolved':     False,\n",

        "        # Core fields — must match what POST /log-incident on the live API expects.\n"
        "        # API auth is a single 'key' field (org_key or emp_key), NOT separate\n"
        "        # org_key/device_key fields. device_key is kept below in shield_meta\n"
        "        # for traceability, just not used for auth.\n"
        "        'id':           f\"inc_{uuid.uuid4().hex[:20]}\",\n"
        "        'key':          config['org_key'],\n"
        "        'source':       'network',              # tells dashboard: Shield, not browser\n"
        "        'risk_level':   risk_level,\n"
        "        'ai_tool':      tool['name'],\n"
        "        'user_email':   None,                   # filled in later when IP->employee mapping exists\n"
        "        'ip_address':   verdict['ip'],\n"
        "        'message':      verdict.get('reason', 'Network threat detected'),\n"
        "        'timestamp':    datetime.utcnow().isoformat() + 'Z',\n"
        "        'resolved':     False,\n",
    ),
    (
        "            'device_name':   config.get('device_name', 'Syphir Shield'),\n"
        "            'firmware':      config.get('firmware_version', '1.0.0'),\n",

        "            'device_name':   config.get('device_name', 'Syphir Shield'),\n"
        "            'device_key':    config.get('device_key'),\n"
        "            'firmware':      config.get('firmware_version', '1.0.0'),\n",
    ),
    (
        "            req = urllib.request.Request(\n"
        "                f\"{self.api_url}/incidents\",\n",

        "            req = urllib.request.Request(\n"
        "                f\"{self.api_url}/log-incident\",\n",
    ),
]


def main():
    if not TARGET.exists():
        print(f"ERROR: {TARGET} not found. Run this from the repo root (-syphir/).")
        sys.exit(1)

    text = TARGET.read_text()
    original = text

    for i, (old, new) in enumerate(EDITS, 1):
        if new in text:
            print(f"Edit {i}: already applied, skipping.")
            continue
        if old not in text:
            print(f"ERROR: Edit {i} target text not found — file may have changed since this script was written.")
            print("Refusing to touch the file. No changes made.")
            sys.exit(1)
        text = text.replace(old, new, 1)
        print(f"Edit {i}: applied.")

    if text == original:
        print("No changes needed — file already patched.")
        return

    TARGET.write_text(text)
    print(f"\nPatched {TARGET}. Now run:")
    print("  git add Block_device/reporter.py")
    print("  git commit -m 'fix: reporter.py auth field + endpoint'")
    print("  git push")


if __name__ == "__main__":
    main()
