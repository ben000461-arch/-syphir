#!/usr/bin/env python3
"""
fix_popup_footer.py

Fixes two stale references in the extension popup footer, found by
actually installing the extension and looking at it:
  - "syphir.io" displayed as the site link label (the button itself
    already correctly opens co-optech.com when clicked - this was
    purely a cosmetic label mismatch, not a broken link)
  - "co|op v1.0.0" hardcoded as static text, disconnected from the
    real manifest version (currently 1.1.1 and climbing)

Rather than just hardcoding the current version number - which would
only recreate the same staleness bug the next time the version bumps -
this wires the footer to read chrome.runtime.getManifest().version at
runtime, so it can never go stale again regardless of future updates.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fix_popup_footer.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
POPUP_HTML = REPO_ROOT / "extension" / "popup.html"
POPUP_JS = REPO_ROOT / "extension" / "popup.js"

OLD_FOOTER = '''  <div class="ftr">
    <span class="ftr-ver">co|op v1.0.0</span>
    <button class="ftr-link" id="siteBtn">syphir.io</button>
  </div>'''

NEW_FOOTER = '''  <div class="ftr">
    <span class="ftr-ver" id="ftrVer">co|op</span>
    <button class="ftr-link" id="siteBtn">co-optech.com</button>
  </div>'''

OLD_JS_INIT = '''document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["syphir_key", "syphir_org", "syphir_expired"], (data) => {'''

NEW_JS_INIT = '''document.addEventListener("DOMContentLoaded", () => {
  const ftrVer = document.getElementById("ftrVer");
  if (ftrVer) ftrVer.textContent = `co|op v${chrome.runtime.getManifest().version}`;

  chrome.storage.local.get(["syphir_key", "syphir_org", "syphir_expired"], (data) => {'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op popup footer fix\n")

    if not POPUP_HTML.exists():
        fail(f"extension/popup.html not found at {POPUP_HTML}")
    if not POPUP_JS.exists():
        fail(f"extension/popup.js not found at {POPUP_JS}")

    html = POPUP_HTML.read_text(encoding="utf-8")
    js = POPUP_JS.read_text(encoding="utf-8")

    if html.count(OLD_FOOTER) != 1:
        fail(f"Expected exactly 1 match of the old footer block in popup.html, "
             f"found {html.count(OLD_FOOTER)}. File may have changed since this script was written.")
    if js.count(OLD_JS_INIT) != 1:
        fail(f"Expected exactly 1 match of the init block in popup.js, "
             f"found {js.count(OLD_JS_INIT)}. File may have changed since this script was written.")

    html = html.replace(OLD_FOOTER, NEW_FOOTER)
    js = js.replace(OLD_JS_INIT, NEW_JS_INIT)

    POPUP_HTML.write_text(html, encoding="utf-8")
    POPUP_JS.write_text(js, encoding="utf-8")

    print(f"\u2713 extension/popup.html updated - footer link now says co-optech.com")
    print(f"\u2713 extension/popup.js updated - version now reads live from the manifest")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: this needs a fresh zip + version bump + re-upload, same flow as last time -")
    print("say the word if you want me to build that zip for you again.")


if __name__ == "__main__":
    main()
