#!/usr/bin/env python3
"""
replace_support_email.py

Replaces every occurrence of the old support email (syphir26@gmail.com)
with the new one (cooptech126@gmail.com) across the entire live codebase.

Found via a full-repo search (both a direct grep and a broader
case-insensitive sweep, to be thorough) - 17 real, live files:
  - api/server.js (9 occurrences - includes EMAIL_REPLYTO, the constant
    that controls where replies to every automated email actually land)
  - dashboard/app.html, auth.js, install.html, billing.html, block.html
  - dashboard/index.html, contact.html, features.html, how-it-works.html
  - dashboard/pricing.html, privacy.html, terms.html
  - dashboard/plan-starter.html, plan-professional.html, plan-institution.html
  - dashboard/syphir-index.html (the confirmed-orphaned page - included
    anyway for completeness, though nothing links to it)

NOT touched: old one-time patch scripts sitting in the repo root (like
finish_install_html_rebrand.py) - those already ran, they're not live
pages, updating them serves no purpose.

This is a plain, uniform string replacement - every occurrence checked
beforehand was plain text (display copy, mailto: links, or the
EMAIL_REPLYTO constant), nothing needed special handling.

Usage:
    cd /path/to/-syphir     # repo root
    python3 replace_support_email.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
OLD_EMAIL = "syphir26@gmail.com"
NEW_EMAIL = "cooptech126@gmail.com"

FILES = [
    "api/server.js",
    "dashboard/app.html",
    "dashboard/auth.js",
    "dashboard/install.html",
    "dashboard/billing.html",
    "dashboard/block.html",
    "dashboard/index.html",
    "dashboard/contact.html",
    "dashboard/features.html",
    "dashboard/how-it-works.html",
    "dashboard/pricing.html",
    "dashboard/privacy.html",
    "dashboard/terms.html",
    "dashboard/plan-starter.html",
    "dashboard/plan-professional.html",
    "dashboard/plan-institution.html",
    "dashboard/syphir-index.html",
]


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print(f"co|op: replace support email {OLD_EMAIL} -> {NEW_EMAIL}\n")

    missing = [f for f in FILES if not (REPO_ROOT / f).exists()]
    if missing:
        fail(f"These expected files are missing: {missing}")

    total = 0
    for rel_path in FILES:
        path = REPO_ROOT / rel_path
        content = path.read_text(encoding="utf-8")
        count = content.count(OLD_EMAIL)
        if count == 0:
            print(f"  \u2192 {rel_path}: 0 occurrences, skipping")
            continue
        new_content = content.replace(OLD_EMAIL, NEW_EMAIL)
        path.write_text(new_content, encoding="utf-8")
        print(f"\u2713 {rel_path}: {count} occurrence(s) replaced")
        total += count

    print(f"\n\u2705 Done. {total} total occurrences replaced across the codebase.")
    print("Nothing was committed or pushed.")
    print("\nNext:")
    print("1. Review: git diff")
    print("2. Commit + push")
    print(f"3. Make sure {NEW_EMAIL} is a real inbox you're actively checking -")
    print("   this now controls where every automated email reply and support")
    print("   request actually lands.")


if __name__ == "__main__":
    main()
