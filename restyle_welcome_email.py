#!/usr/bin/env python3
"""
restyle_welcome_email.py

Restyles the "You're approved — welcome to co|op" email - the actual
first email a real trial customer receives. Old version used the
leftover blue Syphir-era palette (dark navy background, blue button,
blue links) and even had a shield emoji, which the design system
explicitly bans ("no shield logos anywhere - co|op wordmark only").

New version: light background (white), black used as the strong accent
- matches the site's actual black/white/pipe identity, but built for
email specifically rather than a literal copy of the dark web app.
Emails render across wildly inconsistent clients (Outlook, Apple Mail,
Gmail dark mode) that often auto-invert dark-styled HTML unpredictably
- a light background with black accents is both genuinely on-brand and
reliably legible everywhere, which a full dark email isn't guaranteed
to be.

This is the FIRST of several transactional emails using the old
palette - deliberately doing just this one first as a concrete example
before touching the rest (weekly report, upgrade nag, expiry warning,
employee-added notice).

Usage:
    cd /path/to/-syphir     # repo root
    python3 restyle_welcome_email.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"

OLD = '''            <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0d1117;color:#e6edf3;">
              <div style="font-size:22px;font-weight:700;margin-bottom:8px;">Your trial has begun. \U0001F6E1\uFE0F</div>
              <p style="color:#8b949e;margin-bottom:24px;line-height:1.6;">You're approved and your co|op trial is active for the next 7 days. Log in to access your dashboard and start reviewing your logs.</p>
              <a href="https://co-optech.com/app.html?key=${bizKey}&org=${encodeURIComponent(org.name)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-bottom:24px;">Log in to your dashboard \u2192</a>
              <div style="background:#161b22;border:1px solid #1e2636;border-radius:10px;padding:20px;margin-bottom:20px;">
                <div style="font-size:11px;color:#4a5568;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">DASHBOARD KEY</div>
                <div style="font-size:20px;font-weight:700;font-family:'Courier New',monospace;color:#4db8f0;letter-spacing:1px;">${bizKey}</div>
                <div style="font-size:11px;color:#4a5568;margin-top:8px;">Keep this safe \u2014 it's your login. Or just sign in with this email at <a href="https://co-optech.com" style="color:#4db8f0;">co-optech.com</a>.</div>
              </div>
              <p style="color:#4a5568;font-size:12px;line-height:1.6;">Want to pick a plan now? <a href="https://co-optech.com/pricing.html?key=${bizKey}" style="color:#4db8f0;">View plans</a>. Questions? Just reply to this email.</p>
            </div>'''

NEW = '''            <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;background:#ffffff;color:#111111;">
              <div style="font-size:24px;font-weight:800;margin-bottom:24px;letter-spacing:-0.02em;">co<span style="opacity:0.35;">|</span>op</div>
              <div style="font-size:20px;font-weight:700;margin-bottom:8px;">Your trial has begun.</div>
              <p style="color:#555555;margin-bottom:28px;line-height:1.6;">You're approved and your co|op trial is active for the next 7 days. Log in to access your dashboard and start reviewing your logs.</p>
              <a href="https://co-optech.com/app.html?key=${bizKey}&org=${encodeURIComponent(org.name)}" style="display:inline-block;background:#000000;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;margin-bottom:28px;">Log in to your dashboard \u2192</a>
              <div style="background:#f5f5f7;border:1px solid #e5e5e7;border-radius:10px;padding:20px;margin-bottom:20px;">
                <div style="font-size:11px;color:#767676;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">DASHBOARD KEY</div>
                <div style="font-size:20px;font-weight:700;font-family:'Courier New',monospace;color:#000000;letter-spacing:1px;">${bizKey}</div>
                <div style="font-size:11px;color:#767676;margin-top:10px;">Keep this safe \u2014 it's your login. Or just sign in with this email at <a href="https://co-optech.com" style="color:#000000;font-weight:600;">co-optech.com</a>.</div>
              </div>
              <p style="color:#767676;font-size:12px;line-height:1.6;">Want to pick a plan now? <a href="https://co-optech.com/pricing.html?key=${bizKey}" style="color:#000000;font-weight:600;">View plans</a>. Questions? Just reply to this email.</p>
            </div>'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: restyle welcome email to black/white palette\n")

    if not SERVER_JS.exists():
        fail(f"api/server.js not found at {SERVER_JS}")

    content = SERVER_JS.read_text(encoding="utf-8")
    if content.count(OLD) != 1:
        fail(f"Expected 1 match, found {content.count(OLD)}. File may have changed since this script was written.")

    content = content.replace(OLD, NEW)
    SERVER_JS.write_text(content, encoding="utf-8")

    print("\u2713 api/server.js updated - welcome email restyled")
    print("  - dark navy -> white background")
    print("  - blue button -> black button")
    print("  - shield emoji removed (design system: wordmark only, no shields)")
    print("  - added an actual co|op wordmark header")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: git diff api/server.js to review, then commit/push yourself.")
    print("\nTest it for real: approve a test signup from the admin panel and look")
    print("at the actual email that arrives, not just the code.")


if __name__ == "__main__":
    main()
