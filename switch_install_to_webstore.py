#!/usr/bin/env python3
"""
switch_install_to_webstore.py

Replaces dashboard/install.html's old multi-step "download zip, enable
developer mode, load unpacked" wizard with a single clean screen that
links straight to the real, live Chrome Web Store listing. Now that the
extension is actually published and approved, the old flow is obsolete
- Chrome's own "Add to Chrome" button on the Store page handles
permissions and install natively, better than the custom wizard did.

What changes:
  - One screen instead of three, one button instead of a multi-step flow
  - Button links to: https://chromewebstore.google.com/detail/coop/pjiecheghojfaippohdocghkphjjakjd
  - Keeps the co|op branding, the personalized "your company has added
    you" line, and syphir26@gmail.com as the support contact (unchanged,
    protected address)
  - Drops the old zip download, developer-mode instructions, and the
    unverifiable fake "done" screen entirely

Does NOT touch dashboard/extension/coop-extension.zip or the extension/
folder - those still exist for reference/local testing, just no longer
linked from this page.

Usage:
    cd /path/to/-syphir     # repo root
    python3 switch_install_to_webstore.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
INSTALL_PATH = REPO_ROOT / "dashboard" / "install.html"

# Guard: confirm this is genuinely the file we expect before overwriting -
# check for a marker from the OLD version so we don't blindly clobber
# something that's already changed since this script was written.
OLD_VERSION_MARKER = "Load the extension</div><div class=\"step-desc\">Drag and drop or load unpacked"

NEW_HTML = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Install co|op</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: 'Inter', sans-serif;
  background: #0d1117;
  color: #e6edf3;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.card {
  background: #161b25;
  border: 1px solid #242d3e;
  border-radius: 16px;
  padding: 40px;
  max-width: 480px;
  width: 100%;
  text-align: center;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
  margin-bottom: 24px;
}
.logo-text { font-size: 22px; font-weight: 800; }
.logo-text span { color: #4db8f0; }

h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
.sub { font-size: 14px; color: #8b949e; margin-bottom: 28px; line-height: 1.6; }

.btn {
  display: block; width: 100%; padding: 14px;
  background: #2196d3; color: #fff; text-align: center;
  border-radius: 8px; font-size: 14px; font-weight: 700;
  text-decoration: none; cursor: pointer; border: none;
  font-family: 'Inter', sans-serif;
  box-shadow: 0 4px 14px rgba(33,150,211,0.3);
  transition: background 0.15s; margin-bottom: 16px;
}
.btn:hover { background: #1565a8; }

.after-box {
  background: #1c2333; border: 1px solid #242d3e;
  border-radius: 8px; padding: 14px; margin-bottom: 16px;
  font-size: 12px; color: #8b949e; line-height: 1.6; text-align: left;
}
.after-box strong { color: #e6edf3; }

.note { font-size: 11px; color: #4a5568; margin-top: 4px; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">

  <div class="logo">
    <div class="logo-text">co<span>|</span>op</div>
  </div>

  <h1>Install co|op</h1>
  <p class="sub">Your company has added you to their AI data protection system. Installs straight from the Chrome Web Store — takes about 15 seconds.</p>

  <a href="https://chromewebstore.google.com/detail/coop/pjiecheghojfaippohdocghkphjjakjd" class="btn" target="_blank" rel="noopener">Add co|op to Chrome →</a>

  <div class="after-box">
    <strong>After installing:</strong> click the puzzle piece icon 🧩 in your Chrome toolbar, then pin co|op so it's always visible. Click the co|op icon and enter your employee key + work email to activate.
  </div>

  <p class="note">Free to install · Works on Chrome, Edge, and Brave</p>
  <p class="note">Having trouble? Email us at syphir26@gmail.com</p>

</div>
</body>
</html>
'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op install.html -> Chrome Web Store link switch\n")

    if not INSTALL_PATH.exists():
        fail(f"dashboard/install.html not found at {INSTALL_PATH}")

    current = INSTALL_PATH.read_text(encoding="utf-8")

    if OLD_VERSION_MARKER not in current:
        fail(
            "Expected marker text from the old multi-step wizard version "
            "was not found in the current install.html. It may have "
            "already been changed since this script was written - "
            "stopping before overwriting anything."
        )

    old_size = len(current)
    INSTALL_PATH.write_text(NEW_HTML, encoding="utf-8")
    new_size = len(NEW_HTML)

    print(f"\u2713 dashboard/install.html replaced")
    print(f"  old size: {old_size} bytes")
    print(f"  new size: {new_size} bytes")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("Next: review with a browser preview or git diff, then commit/push yourself.")


if __name__ == "__main__":
    main()
