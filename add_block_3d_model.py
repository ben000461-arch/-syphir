#!/usr/bin/env python3
"""
add_block_3d_model.py

Adds the interactive 3D Block model to the site:
  1. Saves the model itself as dashboard/block-3d.html - its own
     standalone page, unchanged from what was built (still loading
     Three.js from cdnjs, which is fine for real visitors - only this
     sandbox's restricted network couldn't reach it during testing).
  2. Embeds it via an iframe on dashboard/block.html, positioned
     exactly where asked: between the "Meet | The Block" hero and the
     "Network-level protection" section.

Why an iframe instead of merging the code directly into block.html:
the model's own page does a full-viewport app reset (html/body set to
overflow:hidden, height:100%) which is correct for the model as its
own page, but would break block.html's normal page scrolling if merged
in directly. An iframe keeps the model's styles fully contained to
itself with zero risk of leaking out and breaking the rest of the
page - the safer integration for a live marketing page.

Sized to match the page's existing content width (1160px, same as
every other section) and given a generous height so the model has
room to actually look good, not cramped.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_block_3d_model.py
"""

import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
MODEL_SOURCE = REPO_ROOT / "coop_block_3d_mockup_v2.html"   # place uploaded file here first
MODEL_DEST = REPO_ROOT / "dashboard" / "block-3d.html"
BLOCK_HTML = REPO_ROOT / "dashboard" / "block.html"

HTML_OLD = '''    <div class="hero-cta" style="display:flex;gap:14px;flex-wrap:wrap;margin-top:36px;">
      <button class="btn-solid" onclick="openWaitlist()">Join the waitlist →</button>
      <a href="pricing.html" class="btn-line">See all pricing</a>
    </div>
  </div>
</div>

<div class="section">
  <div class="wrap">
    <div class="section-head">
      <div class="section-eyebrow">What it unlocks</div>
      <h2 class="section-title">Network-level protection.</h2>'''

HTML_NEW = '''    <div class="hero-cta" style="display:flex;gap:14px;flex-wrap:wrap;margin-top:36px;">
      <button class="btn-solid" onclick="openWaitlist()">Join the waitlist →</button>
      <a href="pricing.html" class="btn-line">See all pricing</a>
    </div>
  </div>
</div>

<div class="wrap" style="margin-top:8px; margin-bottom:64px;">
  <iframe src="block-3d.html" title="co|op Block 3D model" loading="lazy"
    style="width:100%; height:640px; border:1px solid #1a1a1a; border-radius:16px; display:block; background:#000;">
  </iframe>
</div>

<div class="section">
  <div class="wrap">
    <div class="section-head">
      <div class="section-eyebrow">What it unlocks</div>
      <h2 class="section-title">Network-level protection.</h2>'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: add 3D Block model to block.html\n")

    if not MODEL_SOURCE.exists():
        fail(f"{MODEL_SOURCE.name} not found in repo root - copy the model file here first "
             f"(same folder as this script), then re-run.")
    if not BLOCK_HTML.exists():
        fail(f"dashboard/block.html not found at {BLOCK_HTML}")

    content = BLOCK_HTML.read_text(encoding="utf-8")
    if content.count(HTML_OLD) != 1:
        fail(f"Expected 1 match, found {content.count(HTML_OLD)}. block.html may have changed since this script was written.")

    MODEL_DEST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(MODEL_SOURCE, MODEL_DEST)
    print(f"\u2713 dashboard/block-3d.html created ({MODEL_DEST.stat().st_size} bytes)")

    content = content.replace(HTML_OLD, HTML_NEW)
    BLOCK_HTML.write_text(content, encoding="utf-8")
    print(f"\u2713 dashboard/block.html updated - model embedded between the two sections")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: git diff dashboard/block.html, then:")
    print("  git add dashboard/block-3d.html dashboard/block.html")
    print("  git commit -m 'Add interactive 3D Block model to block.html'")
    print("  git push")
    print("\nThen check co-optech.com/block.html for real - scroll, drag the model,")
    print("try Explode. A real browser can reach cdnjs fine, so it should just work.")


if __name__ == "__main__":
    main()
