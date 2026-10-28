#!/usr/bin/env python3
"""
polish_block_3d_embed.py

Two purely visual tweaks, nothing functional touched:
  1. Removes the iframe's own border/radius on block.html - the model
     was sitting in a visible bordered box, this makes it blend
     straight into the black page instead.
  2. Removes the decorative ring mesh from the 3D scene itself (the
     thin circular outline under the model) - the soft shadow the
     model casts on the ground plane stays, since that's what makes it
     look grounded rather than floating; only the extra decorative
     ring line goes.

Drag-to-rotate, auto-spin, scroll-to-zoom, explode/reassemble - all
completely untouched.

Usage:
    cd /path/to/-syphir     # repo root
    python3 polish_block_3d_embed.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
BLOCK_HTML = REPO_ROOT / "dashboard" / "block.html"
MODEL_HTML = REPO_ROOT / "dashboard" / "block-3d.html"

IFRAME_OLD = '''  <iframe src="block-3d.html" title="co|op Block 3D model" loading="lazy"
    style="width:100%; height:640px; border:1px solid #1a1a1a; border-radius:16px; display:block; background:#000;">
  </iframe>'''

IFRAME_NEW = '''  <iframe src="block-3d.html" title="co|op Block 3D model" loading="lazy"
    style="width:100%; height:640px; border:none; display:block; background:#000;">
  </iframe>'''

RING_OLD = '''  const ring = new THREE.Mesh(new THREE.RingGeometry(3.4,3.42,80), new THREE.MeshBasicMaterial({color:0x161616, side:THREE.DoubleSide, transparent:true, opacity:0.6}));
  ring.rotation.x = -Math.PI/2;
  ring.position.y = -1.04;
  scene.add(ring);'''

RING_NEW = '''  // decorative ground ring removed - shadow-only ground plane above stays'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def apply(path, old, new, label):
    if not path.exists():
        fail(f"{path} not found")
    content = path.read_text(encoding="utf-8")
    found = content.count(old)
    if found != 1:
        fail(f"[{label}] Expected 1 match, found {found}. File may have changed.")
    content = content.replace(old, new)
    path.write_text(content, encoding="utf-8")
    print(f"\u2713 {path.relative_to(REPO_ROOT)} updated")


def main():
    print("co|op: remove iframe border and decorative ground ring\n")
    apply(BLOCK_HTML, IFRAME_OLD, IFRAME_NEW, "block.html")
    apply(MODEL_HTML, RING_OLD, RING_NEW, "block-3d.html")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("Next: git diff, then commit/push yourself.")


if __name__ == "__main__":
    main()
