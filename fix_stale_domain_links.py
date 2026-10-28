#!/usr/bin/env python3
"""
fix_stale_domain_links.py

Fixes every remaining reference to the old syphir.vercel.app domain in
api/server.js - 20 occurrences, found via a full-repo search. This is the
highest-priority fix from tonight's outreach-readiness check: these links
sit in the welcome/approval email, the Stripe checkout success/cancel
URLs, the billing portal return link, and the trial-expiry and weekly
report emails - i.e. exactly the links a real, paying customer would
click at the most important moments in the whole funnel.

Two separate bugs, fixed together:
  1. Wrong domain everywhere (syphir.vercel.app instead of co-optech.com)
  2. FOUR of these links also have an extra "/dashboard/" path segment
     that doesn't exist on the live site (confirmed against every real
     screenshot from tonight, which consistently show the working URL
     as co-optech.com/app.html - no /dashboard/ prefix). Those four
     would have been broken even after a plain domain swap, so this
     removes the bad path segment too, not just the domain.

Verified via simulation before writing anything: all 20 occurrences
resolve to zero remaining old-domain references, and the 4 path-bug
lines were manually checked to produce exactly the correct URL.

NOT touched: dashboard/syphir-index.html, which also has one old-domain
reference - that page is the already-confirmed orphan nothing links to,
consistent with every earlier decision to leave it alone.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fix_stale_domain_links.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"

OLD_DOMAIN = "syphir.vercel.app"
NEW_DOMAIN = "co-optech.com"
BAD_PATH_PREFIX = f"{OLD_DOMAIN}/dashboard/"
GOOD_PATH_PREFIX = f"{NEW_DOMAIN}/"


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: fix stale syphir.vercel.app links (domain + path bug)\n")

    if not SERVER_JS.exists():
        fail(f"api/server.js not found at {SERVER_JS}")

    content = SERVER_JS.read_text(encoding="utf-8")
    original_count = content.count(OLD_DOMAIN)

    if original_count == 0:
        fail("No occurrences of the old domain found - file may have already been fixed.")

    # Step 1: fix the 4 links that ALSO have the bad /dashboard/ path
    # segment - domain and path fixed together in one motion.
    content = content.replace(BAD_PATH_PREFIX, GOOD_PATH_PREFIX)
    after_step1 = content.count(OLD_DOMAIN)
    path_bugs_fixed = original_count - after_step1

    # Step 2: every remaining plain domain reference.
    content = content.replace(OLD_DOMAIN, NEW_DOMAIN)
    remaining = content.count(OLD_DOMAIN)

    if remaining != 0:
        fail(f"{remaining} occurrence(s) of the old domain still remain after "
             f"both replacement steps - something unexpected in the file structure.")

    SERVER_JS.write_text(content, encoding="utf-8")
    print(f"\u2713 api/server.js updated")
    print(f"  - {path_bugs_fixed} link(s) had the extra /dashboard/ path bug - fixed both issues at once")
    print(f"  - {original_count} total occurrences of the old domain replaced")
    print(f"  - 0 remaining")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext:")
    print("1. Review: git diff api/server.js")
    print("2. Commit + push")
    print("3. This is the one worth a real live test before outreach: approve a")
    print("   test signup from the admin panel and actually click the welcome")
    print("   email's login link end to end, rather than just trusting the code.")


if __name__ == "__main__":
    main()
