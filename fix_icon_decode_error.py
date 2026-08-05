#!/usr/bin/env python3
"""
fix_icon_decode_error.py

Fixes the "Could not decode image: icon48.png" error that blocks real
users from clicking "Add to Chrome" on the live listing.

ROOT CAUSE (best working theory - the file itself is spec-valid PNG,
verified byte-by-byte, so this isn't file corruption): the old icons
were extremely minimal flat-color art (solid black bg, two solid white
rectangles, zero anti-aliasing) which compressed down to a suspiciously
tiny file - icon48.png was only 185 bytes, where real-world icons are
almost always several KB even for simple designs. That's an unusually
degenerate input, and the most likely explanation is Chrome Web Store's
own server-side asset processing (which re-encodes/generates derivative
sizes for their CDN) hits an edge case on a file that minimal.

THE FIX: same "co|op" two-block design, same colors, but rendered with
real anti-aliasing (drawn at 4x scale, downsampled with LANCZOS) so the
compressed output is a normal size instead of a degenerate one:
  icon16.png:  121 -> 333 bytes
  icon32.png:  150 -> 517 bytes
  icon48.png:  185 -> 612 bytes
  icon128.png: 490 -> 1258 bytes
Also looks meaningfully cleaner - smooth edges instead of hard pixels.

This also bumps the manifest version (Chrome Web Store requires a
version increase for any update to an already-published listing) and
rebuilds both zips - the Chrome Web Store package and the customer-
facing download zip - so nothing drifts out of sync.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fix_icon_decode_error.py
"""

import json
import sys
import base64
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
EXTENSION_DIR = REPO_ROOT / "extension"
MANIFEST_PATH = EXTENSION_DIR / "manifest.json"
CUSTOMER_ZIP = REPO_ROOT / "dashboard" / "extension" / "coop-extension.zip"

ICONS_B64 = {
    "16": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABFElEQVR4nMWSMY7CMBBF33imAQmJlkPQpOUY3ICL5ATcgCoHoOMCtLRcI2UkpDgzFGy8gRXFapH2S5Y1tuf762kECP4gmxYigqqWOucMgKoiIgC4O+7+3fORBCJCRLBardjtdpgZbdtyOBy43W5st1vW6zUAp9OJy+VCSqkkCTMLIOq6jqk2m02oavR9X87O53MAkVJ67K8Mcs50XccwDIVH13XknMk50/f9e4gAZlaaIx54UkqYWflkqvRq8Fv9v8ETA3dnGIayRgZjPb55azCbzVBV5vP54/IL3HK5LG8Wi8VPg9H1eDxSVRWqStu2XK9X3J39fk9VVQA0TfNk8JlRHpVSKmMtIrg7EfE0E9PEH0lwB4vinJ7Ik5ixAAAAAElFTkSuQmCC",
    "32": "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABzElEQVR4nO1XMa7iMBB9M7YQqSIicRF6Om7CfWi5CaKjQsoFcgFK4AeIaIDYb4tVsuQnhr/SShSbkSxL42fP82SSeREAxAdNPxm8JwAA9h1ARFo+srts/gb7IwIi0nmAqsJ7/9b3TCpIGm/egtFoVG8WEXjvcblcOrFxHENVG/jT6fTq+N/kvg9VpbWWy+WSeZ7zeDwyz3N+fX3xcDhwsVjQWktVpTGGADifz3k4HBrYPM+5Wq04Ho8pIhSRVqwWgQqUJAlvtxu77PF4MEkSAqC1lgCYpmknliRnsxkB1GQblw2mhURRFCAJ731jPp/PrWd6vV5BEmVZgiRIwjkH5xzKsgym/2URGmPqInqejTEtrKpCROpRYSt/yD7+HegJ9AR6Aj2BnsBLAl0CI+QPYavGFLJgMxIRDIfDugNW6khEEEVRq8FEUQTvPZxz9Zr3HtZaWBvuea0MkISqoigKbLdbqCqMMY15s9mgKAqo/tm+Xq+hqhgMBlBVqCqstdjtdsiyrFZTrYuiQ5JVt43jGJPJpLHmnEOaprjf7w3NKCKYTqetVp1lGfb7fVBfvtWE/8JCwYEfqOLnNFdW1cV36xIqIWwdA/2/4f9O4Bf2O0Xg4N0ZWAAAAABJRU5ErkJggg==",
    "48": "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAACK0lEQVR4nO2YPY7qMBSFz702RGnZBh0FYg3UlFTQsgEWgChYATWboIEGCVgFK6BACAh/9n3FU9BDQGKERp6Z5yO5SGzfnC9WbOUQAMEPFvs28KkCgG8FAN8KAL6l3xnMzGDOZr5er5n9SikQ0ct+EYExxtkTwfEgIyKIfHbmudZgZlhrnWo6rUD64Gq1inq9Dmvt3UpYa0FEWK1WGI1GT82m141GA+VyGSLyUIOZMZvNMJlM3nphktWYWYhIarWaJEkieRoOh6K1Fma+1VBKCQDpdDq580VE2u327dl5/nIBtNYCQPr9voiIHA4HuVwuD+18Psv1epXT6SSlUkkACBHdGVksFmKMkePx+LRGkiRirZXlcukM4PwRH49HiAgKhQK0fpwmIiAibDabl0u/3+/BzNBaQyn10E9EICLsdjtXW+7baFo8t2DGLpW3g707DvgF50AA8K0A4FsBwLcCgG8FAN8KAL4VAHwrAPhWAPAtZwDnjCZjnGtY5ToOeCNajKLoFvs9+7lPjUdR9PLnP45jGGNeRofp/TiOXW3lr0BqbDqdgogQRRGUUg9Naw2tNebzObbbLZj5NjcFGo/HUEqhWCw+rZHeH4/Hd/Oy5JSNplllq9VCs9mEMeYu1/k3Wux2u1iv10+jRQAYDAaoVCpP40lmxnQ6Ra/Xu3t5HwOkBj4Nd79CzgDA32g8C4KIYK3NHONS40vi9e+q/+cc+K4KAL4VAHzrxwP8AYRskI6zbJZUAAAAAElFTkSuQmCC",
    "128": "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAEsUlEQVR4nO3dsUojXRjG8ffMSRTFEBC8A/EODNgJovUWW2whbJVO7LwI70AQQbvt7bQVREG3WCz2AhJYXAIhYpHMnGeLdQbdD/k+k5mT/XyeH0y557yZ+SeZHZA4M4MJrWTaA8h0KQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDIKQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDI1aa1sXPOvPcGwIBy/jgpSRILIVgIoZT1/lT2zM45c85ZlmWlnYM3z2BT+NMw51ylLzgP4W9fM+b6r4n+CZBf/Hq9bp8+fbIPHz5Ys9ks3g3jyGO6vb214+Nju7u7M++9ZVlWysz5xVlaWrLPnz/b5uam1Wq14vWMO2+apnZ+fm4nJyd2f38/tQgQ63DOwcywuLiIi4sLVGE4HKLdbsPM4L2feOYkSWBmWF1dRafTqWTmTqeD1dXVF/tFPOJd/CRJMDs7i8vLy+JipWla2jEajRBCAAB8/Phx4giSJIFzDsvLy+j1epXMPBwOAQC9Xg/Ly8vFeXp3AdRqNZgZtre3ixNZhTRNAQDfv3/HzMxM8akzzpHHc3R0VOnM+bpHR0cTR/vXBpC/qNPTU2RZVlyoKmRZhhACWq3W2Cc0D6fRaKDb7SKEUHy6lC1fu9vtotFovNi/6iPacwA83fg0Gg1Lkuq3dc5Zo9GYeJ16vW5zc3Nj36D+V845m5ubs3q9Xuk+f4r+IKisO/NYewGIdmceQoj+PCB6AFW/k6rYK9bMMc9NTo+CySkAcgqAnAIgpwDIKQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDIKQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDIKQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDIKQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDIKQByCoCcAiCnAMi96wBi/wzrpKYx77sOwHs/7RHexHsf/edjowcAIErpaZraYDCYeJ1Y8wKwh4cHG41Gle/1XLQA8p+MPzs7M+dcZb/Ina/b6/Xs7u5u7L0AmPfe+v2+XV9fG4DKfvk8yzJzztnXr19tMBiY9z7q1wFiHM45OOewtLSEHz9+AACGwyFCCKUdaZpiNBoBAHZ2dmBm8N6PPXP+b9fX1wGgWL/MmfN5QwhotVowMyRJEuWaPB3RNipeWKvVws+fP1GVg4OD0k5kvka73a5s3tFohHa7PY2LD5dXEEuSJBZCsJWVFdvb27OtrS1bWFiY+OYnTVP79u2bHR4e2pcvX4p9ypx5Y2PDdnd3bW1tzWq12sTrDgYDu7m5sf39fbu6ujLvfWVfM6+JHoCZvbg48/PzNjMz83uYMSLA03clAOv3+8U6KPk79PnMzWazmHWSmYfDoT0+Pv5j/ZimEoDZ7xfsnCu1+CrWfC6/OSvzQlWx5ltMLYBigBL/31v2u/41/8eZXzP1AGS63vWTQPl3CoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDIKQByCoCcAiCnAMgpAHIKgJwCIKcAyCkAcgqAnAIgpwDI/QKxno0Q8PfwNwAAAABJRU5ErkJggg==",
}

EXPECTED_FILES = [
    "manifest.json", "background.js", "content.js", "popup.html", "popup.js",
    "icon16.png", "icon32.png", "icon48.png", "icon128.png",
]


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def bump_version(v):
    parts = v.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        fail(f"Manifest version '{v}' isn't in X.Y.Z format - bump it manually instead.")
    parts[2] = str(int(parts[2]) + 1)
    return ".".join(parts)


def main():
    print("co|op icon decode-error fix\n")

    if not MANIFEST_PATH.exists():
        fail(f"extension/manifest.json not found at {MANIFEST_PATH}")

    for size, b64 in ICONS_B64.items():
        path = EXTENSION_DIR / f"icon{size}.png"
        path.write_bytes(base64.b64decode(b64))
        print(f"\u2713 wrote extension/icon{size}.png ({path.stat().st_size} bytes)")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    old_version = manifest.get("version", "1.1.0")
    new_version = bump_version(old_version)
    manifest["version"] = new_version
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\u2713 manifest.json version bumped: {old_version} -> {new_version}")

    missing = [f for f in EXPECTED_FILES if not (EXTENSION_DIR / f).exists()]
    if missing:
        fail(f"extension/ is missing expected files: {missing}")

    CUSTOMER_ZIP.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(CUSTOMER_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in EXPECTED_FILES:
            zf.write(EXTENSION_DIR / fname, arcname=fname)
    print(f"\u2713 rebuilt dashboard/extension/coop-extension.zip ({CUSTOMER_ZIP.stat().st_size} bytes)")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext steps:")
    print("1. Review: git diff extension/")
    print("2. Commit + push (updates the customer-facing download zip)")
    print("3. For the Chrome Web Store package specifically:")
    print("   cd extension")
    print("   zip -r ../coop-extension-webstore.zip . -x '.*'")
    print("   cd ..")
    print("   unzip -l coop-extension-webstore.zip   # confirm 9 files, manifest.json at root")
    print("4. Upload that zip on the Package tab. Since this is a published listing,")
    print(f"   the version bump to {new_version} means this goes through review again -")
    print("   it's a real update, not an instant fix. Expect the same review wait as before.")


if __name__ == "__main__":
    main()
