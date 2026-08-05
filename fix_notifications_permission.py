#!/usr/bin/env python3
"""
fix_notifications_permission.py

Fixes the Chrome Web Store rejection: "notifications" was declared in
extension/manifest.json but chrome.notifications is never actually
called anywhere in the extension's JS - confirmed by grepping
background.js, content.js, and popup.js before writing this script.
The block UI is a DOM overlay content.js injects into the page, not
a native OS notification, so this permission was genuinely unused.

This script:
  1. Removes "notifications" from extension/manifest.json (the source
     of truth used for the Chrome Web Store package upload).
  2. Rebuilds dashboard/extension/coop-extension.zip from the corrected
     extension/ folder, so the zip customers actually download through
     install.html matches - these are two separate copies of the same
     9 files and it's easy for them to drift out of sync otherwise.

Nothing else in the manifest is touched - host_permissions (45 domains),
icons, activeTab/storage/alarms all stay exactly as they are.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fix_notifications_permission.py
"""

import json
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = REPO_ROOT / "extension" / "manifest.json"
EXTENSION_DIR = REPO_ROOT / "extension"
CUSTOMER_ZIP = REPO_ROOT / "dashboard" / "extension" / "coop-extension.zip"

EXPECTED_FILES = [
    "manifest.json", "background.js", "content.js", "popup.html", "popup.js",
    "icon16.png", "icon32.png", "icon48.png", "icon128.png",
]


def fail(msg):
    print(f"\n❌ ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op notifications permission fix\n")

    if not MANIFEST_PATH.exists():
        fail(f"extension/manifest.json not found at {MANIFEST_PATH}")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    if "notifications" not in manifest.get("permissions", []):
        fail("'notifications' not found in permissions - manifest may "
             "have already been fixed, or changed since this script was written.")

    manifest["permissions"].remove("notifications")
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"✓ extension/manifest.json updated - permissions now: {manifest['permissions']}")

    missing = [f for f in EXPECTED_FILES if not (EXTENSION_DIR / f).exists()]
    if missing:
        fail(f"extension/ is missing expected files: {missing}")

    CUSTOMER_ZIP.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(CUSTOMER_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in EXPECTED_FILES:
            zf.write(EXTENSION_DIR / fname, arcname=fname)
    print(f"✓ rebuilt dashboard/extension/coop-extension.zip ({CUSTOMER_ZIP.stat().st_size} bytes)")

    print("\n✅ Done. Nothing was committed or pushed.")
    print("\nNext steps:")
    print("1. Review: git diff extension/manifest.json")
    print("2. Commit + push (this updates the customer-facing download zip)")
    print("3. Separately, for the Chrome Web Store package specifically:")
    print("   cd extension")
    print("   zip -r ../coop-extension-webstore.zip . -x '.*'")
    print("   cd ..")
    print("   unzip -l coop-extension-webstore.zip   # confirm 9 files, manifest.json at root")
    print("   Then upload that zip on the Package tab and resubmit for review.")
    print("4. On the Privacy tab, you can clear out the old 'notifications justification'")
    print("   text field too - it's no longer needed since the permission is gone.")


if __name__ == "__main__":
    main()
