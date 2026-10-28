#!/usr/bin/env python3
"""
fade_block_3d_edges.py

Two changes to fix the cutoff issue:
  1. Taller iframe (640px -> 820px) so the exploded state has real
     room and rarely reaches the edges at all during normal use.
  2. A soft edge-fade via CSS mask-image on the iframe itself - any
     content that DOES approach the top/bottom edges (extreme zoom-out,
     full explode) dissolves smoothly into the page's black background
     instead of being hard-clipped by the iframe boundary.

Honest technical note on the "blur behind the text" idea specifically:
an iframe is a separate document with a hard rectangular boundary -
there's no way to make its contents visually blend behind the parent
page's actual text the way a CSS backdrop-blur would. What this DOES
achieve is very close in effect: instead of a sharp cut line, the
model fades to transparent/black at the edges, which reads as
"dissolving away" rather than "getting chopped off" - same perceived
result, different mechanism.

Since the page background is pure black and the iframe's own
background is pure black, the fade blends seamlessly - there's no
visible seam where the fade zone is.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fade_block_3d_edges.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
BLOCK_HTML = REPO_ROOT / "dashboard" / "block.html"

OLD = '''<div class="wrap" style="margin-top:8px; margin-bottom:64px;">
  <iframe src="block-3d.html" title="co|op Block 3D model" loading="lazy"
    style="width:100%; height:640px; border:none; display:block; background:#000;">
  </iframe>
</div>'''

NEW = '''<div class="wrap" style="margin-top:8px; margin-bottom:64px;">
  <iframe src="block-3d.html" title="co|op Block 3D model" loading="lazy"
    style="width:100%; height:820px; border:none; display:block; background:#000;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%);">
  </iframe>
</div>'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: fade the Block 3D model's edges instead of hard-clipping\n")

    if not BLOCK_HTML.exists():
        fail(f"dashboard/block.html not found at {BLOCK_HTML}")

    content = BLOCK_HTML.read_text(encoding="utf-8")
    if content.count(OLD) != 1:
        fail(f"Expected 1 match, found {content.count(OLD)}. File may have changed since the last script ran.")

    content = content.replace(OLD, NEW)
    BLOCK_HTML.write_text(content, encoding="utf-8")

    print("\u2713 dashboard/block.html updated")
    print("  - iframe height: 640px -> 820px")
    print("  - edges now fade to transparent instead of hard-clipping")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("Next: git diff, then commit/push yourself.")
    print("\nTest it live: explode the model and scroll/zoom around the edges -")
    print("things should dissolve softly now instead of cutting off sharply.")


if __name__ == "__main__":
    main()
