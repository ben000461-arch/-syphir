#!/usr/bin/env python3
"""
add_extension_icons.py

Adds a 16/32/48/128px icon set to extension/ (the "co|op" mark - two white
blocks with a checkpoint gap between them, on black) and wires it into
manifest.json's "icons" and "action.default_icon" fields.

Chrome Web Store requires at least a 128x128 icon to publish a listing.
Right now extension/ has no icon files and manifest.json has no "icons"
field at all, so this needs to exist before you can submit.

The icons are embedded below as base64 so this script is self-contained -
no separate files to copy over first.

Safe to re-run: skips writing an icon file that already exists, and the
manifest edit is guarded the same way as the rebrand script - it verifies
the exact "action" block is still there before touching anything, and
aborts with no changes written if it isn't.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_extension_icons.py
"""

import base64
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
EXT_DIR = REPO_ROOT / "extension"

ICONS_B64 = {
    "icon16.png": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNkYGD4z0ABYKJEM04D/v//z/D//3+CYlgNQFYEY2MTw+sCUsCoAaMG0MYARkZGDDY2MTifgcLsDABXzxoRy5+bzgAAAABJRU5ErkJggg==",
    "icon32.png": "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXUlEQVR4nO3XQQrAIAxE0Yn0/ldOVy5aolYKTaA/2xn0IS7UJLkSp2VuDqAE4FgV3OM7amavun2mJzBaMMp2uo8BXwwAAAAAAAAAAACA2oDZa/ae7XQvmfgb/h1wAjiMFD/nFQj1AAAAAElFTkSuQmCC",
    "icon48.png": "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAgElEQVR4nO3ZQQqAMAwF0R/x/leuK92aYnEozFuH6GBB0EoysrGDvoGvDKAZQDOAds4Mj/H+yqiq3/YkE0+gc9HO3Ko9t+2PkAE0A2gG0AygGUAzgGYAzQCaATQDaAbQDKAZQDOAtjyg+1l81Z52QGfhnzPPbPzRzTKAZgBt+4AL2CoUZc4288sAAAAASUVORK5CYII=",
    "icon128.png": "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABsUlEQVR4nO3aUWqEMBRA0aR0/1u2X/0ZppWCMZV7zgKSp17iCDPHGMcg62P3AOwlgDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHEfe4e4Diu+0vinPOytc48de5XW0+AK2/iivXu2ueuud/ZFsCqi159M58690+2BOAh7Vn/ndsDcEz/j32++QqIE0CcAOIEECeAOAHECSBOAHECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHECiBNAnADiBBAngDgBxAkgTgBxAogTQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHG3BzDnfOQ+T537zJYTYPVFrlr/qXP/ZtsrwEO6Z90zW38DOKbXrPenvccYx7bd2c5XQJwA4gQQJ4A4AcQJIE4AcQKIE0CcAOIEECeAOAHECSBOAHECiBNAnADivgAM5jj/+LHyewAAAABJRU5ErkJggg==",
}

OLD_ACTION_BLOCK = '''  "action": {
    "default_popup": "popup.html",
    "default_title": "co|op"
  },'''

NEW_ACTION_BLOCK = '''  "icons": {
    "16": "icon16.png",
    "32": "icon32.png",
    "48": "icon48.png",
    "128": "icon128.png"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "co|op",
    "default_icon": {
      "16": "icon16.png",
      "32": "icon32.png",
      "48": "icon48.png",
      "128": "icon128.png"
    }
  },'''


def fail(msg):
    print(f"\n❌ ABORTED: {msg}")
    print("Nothing was written. Fix the issue above and re-run.")
    sys.exit(1)


def write_icons():
    print("[1/2] Writing icon files to extension/")
    if not EXT_DIR.exists():
        fail(f"extension/ folder not found at {EXT_DIR}. Run this from the repo root.")

    for filename, b64 in ICONS_B64.items():
        path = EXT_DIR / filename
        if path.exists():
            print(f"  → {filename} already exists, skipping")
            continue
        path.write_bytes(base64.b64decode(b64))
        print(f"  ✓ wrote extension/{filename} ({path.stat().st_size} bytes)")


def wire_manifest():
    print("\n[2/2] Wiring icons into manifest.json")
    manifest_path = EXT_DIR / "manifest.json"
    if not manifest_path.exists():
        fail(f"manifest.json not found at {manifest_path}")

    text = manifest_path.read_text(encoding="utf-8")

    if '"icons"' in text:
        print("  → manifest.json already has an \"icons\" field, skipping (already done)")
        return

    count = text.count(OLD_ACTION_BLOCK)
    if count != 1:
        fail(
            "Expected exactly 1 occurrence of the current \"action\" block, "
            f"found {count}. manifest.json may have changed since this script "
            "was written - stopping before touching anything."
        )

    text = text.replace(OLD_ACTION_BLOCK, NEW_ACTION_BLOCK)
    manifest_path.write_text(text, encoding="utf-8")
    print(f"  ✓ manifest.json updated ({manifest_path.stat().st_size} bytes)")


def main():
    print("co|op extension icon setup")
    print(f"Repo root: {REPO_ROOT}\n")
    write_icons()
    wire_manifest()
    print("\n✅ Done. Nothing was committed or pushed.")
    print("Next: run `git status` / `git diff` to review, then commit/push yourself.")


if __name__ == "__main__":
    main()
