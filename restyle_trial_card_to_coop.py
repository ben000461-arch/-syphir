#!/usr/bin/env python3
"""
restyle_trial_card_to_coop.py

Restyles the trial-expired card - in BOTH places it now lives (app.html's
original, and auth.js's "Open Dashboard" precheck copy) - from the old
blue Syphir palette to the actual current co|op design system.

Color values below were pulled directly from index.html's own CSS custom
properties, not guessed:
    --ink: #ffffff       (main text)
    --paper: #000000     (main background)
    --paper-2: #0a0a0a   (card/panel background)
    --line: rgba(255,255,255,0.12)   (borders)
    --grey: #8a8a8a       (secondary text)
    --grey-dim: #555555   (muted footer text)

The one thing that needed real care rather than a blind color swap: the
"Professional Most Popular" button used to be blue with white text. Since
white is now the accent color in this design system, that button becomes
a WHITE background - which means its text has to switch to BLACK, or it
disappears entirely. That's a documented, recurring gotcha in this
codebase specifically (white-background buttons need black text), and
this script accounts for it explicitly rather than doing a naive global
"replace blue with white" pass that would silently break it.

This only touches color/background/border values on the trial-expired
card's markup - no copy, no layout, no button logic changes.

Usage:
    cd /path/to/-syphir     # repo root
    python3 restyle_trial_card_to_coop.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
APP_HTML = REPO_ROOT / "dashboard" / "app.html"
AUTH_JS = REPO_ROOT / "dashboard" / "auth.js"

# (find substring, replace substring, expected occurrence count on the one
#  matched line). Order doesn't matter - none of these patterns overlap.
COLOR_SWAPS = [
    ("background:rgba(5,8,15,0.82)", "background:rgba(0,0,0,0.82)", 1),
    ("background:#161b25", "background:#0a0a0a", 1),
    ("border:1px solid #242d3e", "border:1px solid rgba(255,255,255,0.12)", 1),
    ("color:#e6edf3", "color:#ffffff", 3),
    ("background:#1c2333", "background:rgba(255,255,255,0.04)", 2),
    ("border:1px solid #2d3a50", "border:1px solid rgba(255,255,255,0.12)", 2),
    ("color:#4db8f0", "color:#ffffff", 2),
    ("background:#2196d3", "background:#ffffff", 1),
    ("color:#fff;", "color:#000000;", 1),   # Professional button text - MUST be black on the new white bg
    ("color:#8b949e", "color:#8a8a8a", 2),
    ("color:#4a5568", "color:#555555", 1),
]

MARKER = "insertAdjacentHTML('beforeend'"


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def restyle_file(path, label):
    if not path.exists():
        fail(f"{path} not found")

    content = path.read_text(encoding="utf-8")
    lines = content.split("\n")

    target_idx = None
    for i, line in enumerate(lines):
        if MARKER in line:
            target_idx = i
            break

    if target_idx is None:
        fail(f"[{label}] Could not find the trial-card line (marker: {MARKER!r}). File may have changed.")

    line = lines[target_idx]

    for old, new, expected in COLOR_SWAPS:
        found = line.count(old)
        if found != expected:
            fail(
                f"[{label}] Expected {expected} occurrence(s) of {old!r} on the "
                f"trial-card line, found {found}. File may have changed since "
                f"this script was written."
            )

    for old, new, _ in COLOR_SWAPS:
        line = line.replace(old, new)

    lines[target_idx] = line
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\u2713 {path.relative_to(REPO_ROOT)} restyled")


def main():
    print("co|op: restyle trial-expired card to match the current design system\n")
    restyle_file(APP_HTML, "app.html")
    restyle_file(AUTH_JS, "auth.js")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: git diff dashboard/app.html dashboard/auth.js to review, then commit/push.")
    print("\nBoth copies of this card were restyled identically, so they stay in sync -")
    print("same known tradeoff as before: two copies, not one shared source.")


if __name__ == "__main__":
    main()
