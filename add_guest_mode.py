#!/usr/bin/env python3
"""
add_guest_mode.py

Adds a "Continue without an account" path to the extension popup for
people who install co|op without a company key - e.g. someone who found
it via a LinkedIn post and just wants to look around. Protection already
works identically with no key (verified earlier by reading content.js -
detection has zero gate on key presence, and logIncident() hard-returns
before any network call if there's no key, so literally nothing is sent
anywhere). This just makes that existing behavior visible and reachable
instead of hiding it behind a dead-end login screen.

Flow added:
  1. Login screen gets a small, muted text link below the Activate
     button: "Continue without an account" - not a competing button,
     styled like the existing footer links.
  2. Clicking it shows a short welcome/info screen: what co|op does, an
     explicit "nothing is collected in this mode" line, a link to
     co-optech.com, a primary "Got it, continue" action, and a plain
     "<- Back" link to return to the login screen.
  3. "Got it" sets a persisted `syphir_guest_mode` flag and shows a
     lightweight "Protection Active - Guest" status view.
  4. On future popup opens with no key but that flag set, the guest
     status view shows directly - never nags with the login screen
     again. That view has its own small "Have a work key? Activate ->"
     link back to the login screen, so nothing is a dead end either way.

Also bumps the manifest version (this is a real change to a published,
live extension) and rebuilds the customer-facing zip.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_guest_mode.py
"""

import json
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
EXTENSION_DIR = REPO_ROOT / "extension"
POPUP_HTML = EXTENSION_DIR / "popup.html"
POPUP_JS = EXTENSION_DIR / "popup.js"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
CUSTOMER_ZIP = REPO_ROOT / "dashboard" / "extension" / "coop-extension.zip"

EXPECTED_FILES = [
    "manifest.json", "background.js", "content.js", "popup.html", "popup.js",
    "icon16.png", "icon32.png", "icon48.png", "icon128.png",
]

# ── popup.html changes ───────────────────────────────────────────────────

HTML_OLD_ACTIVATE_BLOCK = '''    <button class="act-btn" id="actBtn">Activate →</button>
    <div class="msg" id="actMsg"></div>
  </div>'''

HTML_NEW_ACTIVATE_BLOCK = '''    <button class="act-btn" id="actBtn">Activate →</button>
    <div class="msg" id="actMsg"></div>
    <div style="text-align:center; margin-top:10px;">
      <button class="ftr-link" id="guestModeBtn" style="color:#6868a0; font-size:11px;">Continue without an account</button>
    </div>
  </div>

  <div id="guestInfoView" style="display:none;padding:18px 16px;">
    <div class="login-title">Welcome to co|op 👋</div>
    <div class="login-sub">co|op catches sensitive data — SSNs, credit card numbers, API keys — before it's pasted into AI tools like ChatGPT and Claude, right in your browser.</div>
    <div class="login-sub">You're using it without a company account, which is completely fine — protection works exactly the same. Nothing is collected or sent anywhere in this mode.</div>
    <button class="act-btn" id="guestContinueBtn">Got it, continue →</button>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
      <button class="ftr-link" id="guestBackBtn" style="color:#6868a0; font-size:11px;">← Back</button>
      <button class="ftr-link" id="guestLearnBtn" style="font-size:11px;">co-optech.com →</button>
    </div>
  </div>

  <div id="guestActiveView" style="display:none;">
    <div class="section">
      <div class="sec-lbl">Protection Status</div>
      <div class="shield-card">
        <div class="shield-icon"><span style="font-family:'DM Sans',sans-serif;font-weight:700;font-size:13px;color:#fff;">co<span style="font-weight:300;opacity:0.7;">|</span>op</span></div>
        <div>
          <div class="shield-name">Protection Active</div>
          <div class="shield-org">No account — just browsing</div>
        </div>
        <div class="pill" style="background:rgba(255,255,255,0.08); color:#8b8bb0; border-color:rgba(255,255,255,0.14);">Guest</div>
      </div>
      <div class="login-sub" style="margin-top:12px; margin-bottom:0;">Sensitive data is still caught and blocked before it's sent. Nothing is logged or reported anywhere in this mode.</div>
    </div>
    <div class="section" style="border-bottom:none;">
      <button class="toggle-btn" id="guestActivateBtn">Have a work key? Activate →</button>
    </div>
  </div>'''

# ── popup.js changes ─────────────────────────────────────────────────────

JS_OLD_INIT_CHECK = '''  chrome.storage.local.get(["syphir_key", "syphir_org", "syphir_expired"], (data) => {
    if (!data.syphir_key || !data.syphir_org) {
      showLogin();
      return;
    }'''

JS_NEW_INIT_CHECK = '''  chrome.storage.local.get(["syphir_key", "syphir_org", "syphir_expired", "syphir_guest_mode"], (data) => {
    if (!data.syphir_key || !data.syphir_org) {
      if (data.syphir_guest_mode) { showGuestActive(); } else { showLogin(); }
      return;
    }'''

JS_OLD_LISTENER_ANCHOR = '''  document.getElementById("actBtn").addEventListener("click", activate);'''

JS_NEW_LISTENER_ANCHOR = '''  document.getElementById("actBtn").addEventListener("click", activate);

  document.getElementById("guestModeBtn").addEventListener("click", showGuestInfo);
  document.getElementById("guestBackBtn").addEventListener("click", showLogin);
  document.getElementById("guestActivateBtn").addEventListener("click", showLogin);
  document.getElementById("guestLearnBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://co-optech.com" });
  });
  document.getElementById("guestContinueBtn").addEventListener("click", () => {
    chrome.storage.local.set({ syphir_guest_mode: true }, showGuestActive);
  });'''

JS_OLD_SHOWLOGIN = '''function showLogin() {
  document.getElementById("loginView").style.display   = "block";
  document.getElementById("activeView").style.display  = "none";
  document.getElementById("expiredView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-off";
}'''

JS_NEW_SHOWLOGIN = '''function showLogin() {
  document.getElementById("loginView").style.display   = "block";
  document.getElementById("activeView").style.display  = "none";
  document.getElementById("expiredView").style.display = "none";
  document.getElementById("guestInfoView").style.display = "none";
  document.getElementById("guestActiveView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-off";
}

function showGuestInfo() {
  document.getElementById("loginView").style.display   = "none";
  document.getElementById("activeView").style.display  = "none";
  document.getElementById("expiredView").style.display = "none";
  document.getElementById("guestInfoView").style.display = "block";
  document.getElementById("guestActiveView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-off";
}

function showGuestActive() {
  document.getElementById("loginView").style.display   = "none";
  document.getElementById("activeView").style.display  = "none";
  document.getElementById("expiredView").style.display = "none";
  document.getElementById("guestInfoView").style.display = "none";
  document.getElementById("guestActiveView").style.display = "block";
  document.getElementById("statusDot").className = "sdot sdot-on";
}'''

JS_OLD_SHOWEXPIRED = '''function showExpired() {
  document.getElementById("loginView").style.display   = "none";
  document.getElementById("activeView").style.display  = "none";
  document.getElementById("expiredView").style.display = "block";
  document.getElementById("statusDot").className = "sdot sdot-exp";
}'''

JS_NEW_SHOWEXPIRED = '''function showExpired() {
  document.getElementById("loginView").style.display   = "none";
  document.getElementById("activeView").style.display  = "none";
  document.getElementById("expiredView").style.display = "block";
  document.getElementById("guestInfoView").style.display = "none";
  document.getElementById("guestActiveView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-exp";
}'''

JS_OLD_SHOWACTIVE_START = '''async function showActive(orgName, key) {
  document.getElementById("loginView").style.display   = "none";
  document.getElementById("activeView").style.display  = "block";
  document.getElementById("expiredView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-on";'''

JS_NEW_SHOWACTIVE_START = '''async function showActive(orgName, key) {
  document.getElementById("loginView").style.display   = "none";
  document.getElementById("activeView").style.display  = "block";
  document.getElementById("expiredView").style.display = "none";
  document.getElementById("guestInfoView").style.display = "none";
  document.getElementById("guestActiveView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-on";'''

REPLACEMENTS = [
    (POPUP_HTML, HTML_OLD_ACTIVATE_BLOCK, HTML_NEW_ACTIVATE_BLOCK),
    (POPUP_JS, JS_OLD_INIT_CHECK, JS_NEW_INIT_CHECK),
    (POPUP_JS, JS_OLD_LISTENER_ANCHOR, JS_NEW_LISTENER_ANCHOR),
    (POPUP_JS, JS_OLD_SHOWLOGIN, JS_NEW_SHOWLOGIN),
    (POPUP_JS, JS_OLD_SHOWEXPIRED, JS_NEW_SHOWEXPIRED),
    (POPUP_JS, JS_OLD_SHOWACTIVE_START, JS_NEW_SHOWACTIVE_START),
]


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def bump_version(v):
    parts = v.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        fail(f"Manifest version '{v}' isn't in X.Y.Z format - bump it manually instead.")
    parts[2] = str(int(parts[2]) + 1)
    return ".".join(parts)


def main():
    print("co|op: add guest mode (continue without an account)\n")

    file_contents = {}
    for path, old, new in REPLACEMENTS:
        if path not in file_contents:
            if not path.exists():
                fail(f"{path} not found")
            file_contents[path] = path.read_text(encoding="utf-8")
        found = file_contents[path].count(old)
        if found != 1:
            fail(
                f"Expected exactly 1 match in {path.name} for a block starting:\n"
                f"  {old[:80]}...\n"
                f"but found {found}. File may have changed since this script was written."
            )

    for path, old, new in REPLACEMENTS:
        file_contents[path] = file_contents[path].replace(old, new)

    for path, content in file_contents.items():
        path.write_text(content, encoding="utf-8")
        print(f"\u2713 {path.relative_to(REPO_ROOT)} updated")

    if not MANIFEST_PATH.exists():
        fail("extension/manifest.json not found")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    old_version = manifest.get("version", "0.0.0")
    new_version = bump_version(old_version)
    manifest["version"] = new_version
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\u2713 extension/manifest.json version bumped: {old_version} -> {new_version}")

    missing = [f for f in EXPECTED_FILES if not (EXTENSION_DIR / f).exists()]
    if missing:
        fail(f"extension/ is missing expected files: {missing}")

    CUSTOMER_ZIP.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(CUSTOMER_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in EXPECTED_FILES:
            zf.write(EXTENSION_DIR / fname, arcname=fname)
    print(f"\u2713 rebuilt dashboard/extension/coop-extension.zip ({CUSTOMER_ZIP.stat().st_size} bytes)")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext steps:")
    print("1. Review: git diff extension/")
    print("2. Commit + push (updates the customer-facing download zip)")
    print("3. For the Chrome Web Store package specifically:")
    print("   cd extension && rm -f ../coop-extension-webstore.zip")
    print("   zip -r ../coop-extension-webstore.zip . -x '.*'")
    print("   cd .. && unzip -l coop-extension-webstore.zip")
    print(f"4. Upload that zip on the Package tab, resubmit (version is now {new_version}).")


if __name__ == "__main__":
    main()
