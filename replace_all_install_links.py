#!/usr/bin/env python3
"""
replace_all_install_links.py

Replaces every reference to the old install.html flow across the whole
codebase with the real, live Chrome Web Store URL directly - no more
custom intermediary page at all, per Ben's direction to just swap in
the Store URL everywhere the extension gets linked.

Touches 4 real, live locations (found via a full-repo search):
  1. api/server.js - upgrade confirmation email template
  2. api/server.js - employee invite email template
  3. dashboard/app.html - Settings page "Employee Install Link" field
     (both the normal-path and error-fallback-path assignments)
  4. dashboard/bh7x29mq-admin.html - admin panel's per-business
     "Install link" quick-link

Bonus side effect: the two email templates were still hardcoded to the
OLD domain (syphir.vercel.app) - a known open item from earlier. This
fixes that too, since they're being replaced outright rather than
patched in place.

NOT touched: dashboard/syphir-index.html - confirmed orphaned page,
nothing links to it, not worth touching here. dashboard/install.html
itself is left in place but now has nothing pointing to it - safe to
delete later if you want, not done automatically here since deleting
files is a separate, more destructive call than swapping links.

Usage:
    cd /path/to/-syphir     # repo root
    python3 replace_all_install_links.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"
APP_HTML = REPO_ROOT / "dashboard" / "app.html"
ADMIN_HTML = REPO_ROOT / "dashboard" / "bh7x29mq-admin.html"

STORE_URL = "https://chromewebstore.google.com/detail/coop/pjiecheghojfaippohdocghkphjjakjd"

REPLACEMENTS = [
    (
        SERVER_JS,
        "  const installUrl = empKey ? `https://syphir.vercel.app/install.html?key=${empKey}` : 'https://syphir.vercel.app/install.html';",
        f"  const installUrl = '{STORE_URL}';",
    ),
    (
        SERVER_JS,
        "  const installUrl = `https://syphir.vercel.app/install.html?key=${org_key}&email=${employee_email}&org=${encodeURIComponent(org_name || org.name)}`;",
        f"  const installUrl = '{STORE_URL}';",
    ),
    (
        APP_HTML,
        "      const il = document.getElementById('install-link'); if (il) il.value = `https://co-optech.com/install.html?key=${ORG_EMP_KEY || ORG_KEY}`;",
        f"      const il = document.getElementById('install-link'); if (il) il.value = '{STORE_URL}';",
    ),
    (
        APP_HTML,
        "    const il = document.getElementById('install-link'); if (il) il.value = `https://co-optech.com/install.html?key=${ORG_KEY}`;",
        f"    const il = document.getElementById('install-link'); if (il) il.value = '{STORE_URL}';",
    ),
    (
        ADMIN_HTML,
        '${(b.emp_key || b.key) ? `<div style="margin-top:4px;"><a href="install.html?key=${b.emp_key || b.key}" target="_blank" style="font-size:0.72rem; color:var(--muted); text-decoration:none;">\U0001F4CE Install link</a></div>` : \'\'}',
        f'${{(b.emp_key || b.key) ? `<div style="margin-top:4px;"><a href="{STORE_URL}" target="_blank" style="font-size:0.72rem; color:var(--muted); text-decoration:none;">\U0001F4CE Install link</a></div>` : \'\'}}',
    ),
]


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: replace install.html references with Chrome Web Store URL\n")

    file_contents = {}
    for path, old, new in REPLACEMENTS:
        if path not in file_contents:
            if not path.exists():
                fail(f"{path} not found")
            file_contents[path] = path.read_text(encoding="utf-8")
        found = file_contents[path].count(old)
        if found != 1:
            fail(
                f"Expected exactly 1 match in {path.name} for:\n  {old[:100]}...\n"
                f"but found {found}. File may have changed since this script was written."
            )

    for path, old, new in REPLACEMENTS:
        file_contents[path] = file_contents[path].replace(old, new)

    for path, content in file_contents.items():
        path.write_text(content, encoding="utf-8")
        print(f"\u2713 {path.relative_to(REPO_ROOT)} updated")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("Next: git diff to review, then commit/push yourself.")
    print(f"\nAll 4 spots now point directly to:\n  {STORE_URL}")
    print("\ndashboard/install.html itself still exists but nothing links to it anymore -")
    print("safe to delete whenever, not done automatically here.")


if __name__ == "__main__":
    main()
