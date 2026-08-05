#!/usr/bin/env python3
"""
fix_trial_expired_modal.py

Fixes the "trial expired" screen: right now it does
document.body.innerHTML = '...', which wipes out the ENTIRE page - the
sidebar, header, everything - and replaces it with just the locked-out
card floating on a blank background. That's why it feels like a full
separate page instead of a card.

The fix is narrow and low-risk: swap the destructive innerHTML
replacement for an appended overlay (document.body.insertAdjacentHTML)
with a blurred, dimmed backdrop behind it - the existing dashboard shell
stays in the DOM underneath, just visually blurred out. The card's
actual content, copy, buttons, and checkout logic are completely
untouched - only the delivery mechanism changes.

Nothing sensitive is at risk from leaving the shell in the DOM: this
code runs immediately after the key-validation check, before any real
incident/customer data ever gets fetched or rendered (loadData() etc.
never runs for an expired trial - the existing `return` stays in place
for that reason). What's behind the blur is just the static, empty
page shell, not real data.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fix_trial_expired_modal.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
APP_HTML = REPO_ROOT / "dashboard" / "app.html"

OLD_STYLE_LINE = "document.body.style.cssText = 'margin:0;padding:0;overflow:hidden;';"
NEW_STYLE_LINE = "document.body.style.overflow = 'hidden';"

OLD_INNERHTML_PREFIX = "document.body.innerHTML = '<div style=\"position:fixed;inset:0;background:#0d1117;display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;padding:20px;z-index:9999;\">"
NEW_APPEND_PREFIX = "document.body.insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;background:rgba(5,8,15,0.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;padding:20px;z-index:9999;\">"


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: convert trial-expired screen to an overlay card\n")

    if not APP_HTML.exists():
        fail(f"dashboard/app.html not found at {APP_HTML}")

    content = APP_HTML.read_text(encoding="utf-8")

    if content.count(OLD_STYLE_LINE) != 1:
        fail(f"Expected exactly 1 match for the body.style.cssText line, "
             f"found {content.count(OLD_STYLE_LINE)}. File may have changed.")
    if content.count(OLD_INNERHTML_PREFIX) != 1:
        fail(f"Expected exactly 1 match for the innerHTML assignment prefix, "
             f"found {content.count(OLD_INNERHTML_PREFIX)}. File may have changed.")

    # The innerHTML assignment ends with `';` right before the next line
    # (window.startCheckout = ...). We only need to swap the *opening* of
    # the assignment (innerHTML = '<div...) for the append call's opening
    # (insertAdjacentHTML('beforeend', '<div...), plus close the extra
    # paren this adds, right at that same trailing `';`.
    OLD_CLOSER = "Email syphir26@gmail.com</a></div></div>';"
    NEW_CLOSER = "Email syphir26@gmail.com</a></div></div>');"

    if content.count(OLD_CLOSER) != 1:
        fail(f"Expected exactly 1 match for the closing tag sequence, "
             f"found {content.count(OLD_CLOSER)}. File may have changed.")

    content = content.replace(OLD_STYLE_LINE, NEW_STYLE_LINE)
    content = content.replace(OLD_INNERHTML_PREFIX, NEW_APPEND_PREFIX)
    content = content.replace(OLD_CLOSER, NEW_CLOSER)

    APP_HTML.write_text(content, encoding="utf-8")
    print(f"\u2713 dashboard/app.html updated")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: git diff dashboard/app.html to review, then commit/push yourself.")
    print("\nTo actually test this without waiting for a real trial to expire,")
    print("you can temporarily point your browser's dev tools Network tab at the")
    print("/validate-key response for your test org and confirm the modal + blur")
    print("render correctly over the dashboard, then revert.")


if __name__ == "__main__":
    main()
