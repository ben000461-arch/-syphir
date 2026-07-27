#!/usr/bin/env python3
"""
make_dashboard_sandbox.py

Creates dashboard/app-sandbox.html: an exact copy of dashboard/app.html
with the two "co|op Block - coming soon" overlays removed (Intel +
Network Security), so you can see and click around those pages fully
built out - Process Tree, Intel chat, the works - before deciding
whether/when to ship them for real.

Production dashboard/app.html is NEVER touched by this script.

The sandbox file:
  - Is not linked from anywhere in the site nav or sitemap - the only
    way to reach it is to know the exact filename.
  - Hits the same LIVE API (syphir-api.onrender.com) as production,
    same as app.html does. This is fine for viewing (CORS is wildcard,
    already confirmed), but it means anything you click that WRITES
    data (dispatching an agent, resolving an incident) is a real write
    against real Supabase rows for whatever org key you're viewing.
    Use the Meridian Legal Group demo org for this, not a real customer.
  - Gets a bright banner injected at the top so there's no chance of
    mistaking a screenshot of this for the real dashboard.

Safe to re-run: regenerates app-sandbox.html fresh from whatever
app.html currently contains, every time. If you've hand-edited
app-sandbox.html directly, re-running this will overwrite those edits.

Usage:
    cd /path/to/-syphir     # repo root
    python3 make_dashboard_sandbox.py

Then open it locally:
    cd dashboard
    python3 -m http.server 8000
    # visit: http://localhost:8000/app-sandbox.html?key=SYP-AZNC-Y8DX-MJ9K
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SOURCE = REPO_ROOT / "dashboard" / "app.html"
SANDBOX = REPO_ROOT / "dashboard" / "app-sandbox.html"

# Known-good size range for app.html (per the project's own baseline).
# If it's wildly off, something upstream is already wrong - don't build
# a sandbox from a broken source file.
MIN_SIZE = 190_000
MAX_SIZE = 260_000

INTEL_COVER = '''      <!-- co|op Block coming-soon cover -->
      <div class="cs-cover">
        <div class="cs-card">
          <div class="cs-badge">Coming Soon</div>
          <div class="cs-mark">co<span class="p">|</span>op Block</div>
          <div class="cs-title">Network-level protection</div>
          <div class="cs-sub">Intel lets you run plain-English security commands — isolate a device, block an IP, fix a computer — straight from your dashboard. It runs on <strong style="color:#fff;">co|op Block</strong> — our dedicated security appliance that plugs into your network and watches what the browser can't see.</div>
          <a class="cs-btn" href="block.html">Learn about co|op Block →</a>
          <div class="cs-foot">preview shows sample data · live once your Block ships</div>
        </div>
      </div>
'''

NETWORK_COVER = '''      <!-- co|op Block coming-soon cover -->
      <div class="cs-cover">
        <div class="cs-card">
          <div class="cs-badge">Coming Soon</div>
          <div class="cs-mark">co<span class="p">|</span>op Block</div>
          <div class="cs-title">Network-level protection</div>
          <div class="cs-sub">Network Security gives you live threat detection, device isolation, and attack timelines across your whole network. It runs on <strong style="color:#fff;">co|op Block</strong> — our dedicated security appliance that plugs into your network and watches what the browser can't see.</div>
          <a class="cs-btn" href="block.html">Learn about co|op Block →</a>
          <div class="cs-foot">preview shows sample data · live once your Block ships</div>
        </div>
      </div>
'''

SANDBOX_BANNER = '''<body>
  <div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#fbbf24;color:#000;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:0.08em;text-align:center;padding:6px;">
    ⚠ SANDBOX BUILD — NOT LIVE — NOT SHOWN TO CUSTOMERS — for local/internal QA only
  </div>
'''


def fail(msg):
    print(f"\n❌ ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op dashboard sandbox generator")
    print(f"Repo root: {REPO_ROOT}\n")

    if not SOURCE.exists():
        fail(f"dashboard/app.html not found at {SOURCE}. Run this from the repo root.")

    size = SOURCE.stat().st_size
    if not (MIN_SIZE <= size <= MAX_SIZE):
        fail(
            f"dashboard/app.html is {size} bytes, outside the expected "
            f"{MIN_SIZE}-{MAX_SIZE} range. This suggests app.html itself "
            f"may already be in a bad state - fix that first, don't build "
            f"a sandbox from it."
        )

    text = SOURCE.read_text(encoding="utf-8")
    original_len = len(text)

    intel_count = text.count(INTEL_COVER)
    network_count = text.count(NETWORK_COVER)
    body_count = text.count("<body>")

    if intel_count != 1:
        fail(f"Expected exactly 1 Intel coming-soon block, found {intel_count}. "
             f"app.html may have changed since this script was written.")
    if network_count != 1:
        fail(f"Expected exactly 1 Network Security coming-soon block, found {network_count}. "
             f"app.html may have changed since this script was written.")
    if body_count != 1:
        fail(f"Expected exactly 1 '<body>' tag, found {body_count}.")

    text = text.replace(INTEL_COVER, "")
    text = text.replace(NETWORK_COVER, "")
    text = text.replace("<body>", SANDBOX_BANNER)

    SANDBOX.write_text(text, encoding="utf-8")

    print(f"✓ dashboard/app.html untouched ({size} bytes)")
    print(f"✓ dashboard/app-sandbox.html written ({len(text)} bytes)")
    print("\n✅ Done. Nothing was committed or pushed.")
    print("\nTo view it locally:")
    print("  cd dashboard")
    print("  python3 -m http.server 8000")
    print("  open http://localhost:8000/app-sandbox.html?key=SYP-AZNC-Y8DX-MJ9K")
    print("\n(that key is the Meridian Legal Group demo org - use it, not a real customer's key)")
    print("\nIf you want a shareable URL instead of localhost: commit this file to a")
    print("branch (NOT main) and push it - Vercel will build a preview URL for that")
    print("branch automatically, production stays untouched.")


if __name__ == "__main__":
    main()
