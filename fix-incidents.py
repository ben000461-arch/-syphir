#!/usr/bin/env python3
"""
co|op — restore key auth on dashboard fetches.

WHY: /incidents, /stats, /team and /emp-key are key-gated on the server.
The dashboard must send ?key=ORG_KEY or the server returns 401 and the
dashboard renders 0 incidents.

RUN THIS FROM YOUR REPO ROOT (the folder that contains `dashboard/`):
    python3 fix-incidents.py
"""
import os
import sys

TARGET = os.path.join("dashboard", "app.html")

REPLACEMENTS = [
    ("fetch(`${API}/emp-key/${ORG_ID}`)",
     "fetch(`${API}/emp-key/${ORG_ID}?key=${encodeURIComponent(ORG_KEY)}`)"),
    ("fetch(`${API}/incidents/${ORG_ID}`)",
     "fetch(`${API}/incidents/${ORG_ID}?key=${encodeURIComponent(ORG_KEY)}`)"),
    ("fetch(`${API}/stats/${ORG_ID}`)",
     "fetch(`${API}/stats/${ORG_ID}?key=${encodeURIComponent(ORG_KEY)}`)"),
    ("fetch(`${API}/team/${ORG_ID}`)",
     "fetch(`${API}/team/${ORG_ID}?key=${encodeURIComponent(ORG_KEY)}`)"),
]


def main():
    if not os.path.exists(TARGET):
        sys.exit(f"ERROR: {TARGET} not found.\n"
                 "Run this from your repo root (the folder containing `dashboard/`).")

    content = open(TARGET, encoding="utf-8").read()
    size_kb = len(content) / 1024

    # Sanity check: make sure this is actually the dashboard, not another page.
    if "tbl-incidents" not in content or "Risk Breakdown" not in content:
        sys.exit(f"ERROR: {TARGET} does not look like the dashboard "
                 f"({size_kb:.0f} KB). It may have been overwritten by another "
                 "page. Do not patch it — restore the real dashboard first.")

    print(f"Found dashboard: {TARGET} ({size_kb:.0f} KB)")

    already = content.count("ORG_ID}?key=${encodeURIComponent(ORG_KEY)}")
    if already:
        print(f"Already patched ({already} keyed calls). Nothing to do.")
        return

    patched = 0
    for old, new in REPLACEMENTS:
        if old in content:
            content = content.replace(old, new)
            patched += 1
            print(f"  patched: {old[:46]}")

    if patched == 0:
        sys.exit("ERROR: none of the expected fetch calls were found. "
                 "Nothing changed.")

    open(TARGET, "w", encoding="utf-8").write(content)
    print(f"\nDone — patched {patched} call(s).")
    print("Next:  git add -A && git commit -m 'restore key auth' && git push origin main")


if __name__ == "__main__":
    main()
