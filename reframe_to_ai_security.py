#!/usr/bin/env python3
"""
reframe_to_ai_security.py

Two changes across the site, pure wording only - no layout touched:

1. DLP/"data protection" framing -> "AI security" everywhere it appears
   as the company's category description. One accurate "governance"
   mention added too, but placed specifically where it's actually true -
   the dashboard visibility section - not as a blanket category claim.
   (Governance in the strict industry sense means policy/compliance/
   audit work, like ISO 42001 - co|op doesn't do that. What co|op DOES
   do is give a business owner real oversight into how their team
   actually uses AI, which is a fair, accurate, narrower claim to make.)

2. The extension is named "Trace" - wherever the site currently just
   says "the extension" with no name attached, this weaves the name in
   while still explicitly saying "browser extension" alongside it, so
   nobody unfamiliar with the name is left confused about what it is.

Every single occurrence found via a full-site grep before writing this
script - dashboard/syphir-index.html (the confirmed orphaned page
nothing links to) deliberately excluded, consistent with every earlier
decision tonight.

Usage:
    cd /path/to/-syphir     # repo root
    python3 reframe_to_ai_security.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent

# (file, old, new, label)
REPLACEMENTS = [
    (
        "dashboard/index.html",
        '<div class="hero-eyebrow"><span class="tick"></span>Real-time AI data protection</div>',
        '<div class="hero-eyebrow"><span class="tick"></span>Real-time AI security</div>',
        "hero eyebrow",
    ),
    (
        "dashboard/index.html",
        "<p>Send your team one install link. They add the browser extension in about a minute — no account, no key to type, no setup.</p>",
        "<p>Send your team one install link. They add Trace, our browser extension, in about a minute — no account, no key to type, no setup.</p>",
        "install-link blurb",
    ),
    (
        "dashboard/how-it-works.html",
        "<p>No IT department, no complex setup, no training. co|op is built so any small business can deploy enterprise-grade AI data protection in minutes.</p>",
        "<p>No IT department, no complex setup, no training. co|op is built so any small business can deploy enterprise-grade AI security in minutes.</p>",
        "intro blurb",
    ),
    (
        "dashboard/how-it-works.html",
        "<p>Your dashboard gives you a single install link with your key already embedded. Copy it, send it however you like — email, Slack, a group text. Employees click, add the extension in about 60 seconds, and they're covered. No account, no key to type.</p>",
        "<p>Your dashboard gives you a single install link with your key already embedded. Copy it, send it however you like — email, Slack, a group text. Employees click, add Trace — our browser extension — in about 60 seconds, and they're covered. No account, no key to type.</p>",
        "step 02 blurb",
    ),
    (
        "dashboard/how-it-works.html",
        "<h3>The extension watches every prompt in real time</h3>",
        "<h3>Trace watches every prompt in real time</h3>",
        "step 03 heading",
    ),
    (
        "dashboard/how-it-works.html",
        "<p>You see what was caught, when, by whom, and how risky it was. Complete isolation means your incidents never mix with any other organization's. Export to CSV, review the timeline, act on what matters.</p>",
        "<p>You see what was caught, when, by whom, and how risky it was. Complete isolation means your incidents never mix with any other organization's. Export to CSV, review the timeline, act on what matters. This is AI governance in practice — real oversight into how your team actually uses AI, not a policy document nobody reads.</p>",
        "step 04 blurb (governance mention)",
    ),
    (
        "dashboard/app.html",
        "<title>co|op — AI Data Protection</title>",
        "<title>co|op — AI Security</title>",
        "page title",
    ),
    (
        "dashboard/app.html",
        '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Share with employees — they install the extension and are added automatically on first use.</div>',
        '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Share with employees — they install Trace and are added automatically on first use.</div>',
        "settings blurb",
    ),
    (
        "dashboard/app.html",
        '''<button onclick="ptSetFilter('extension',this)" class="pt-filter-btn">Extension</button>''',
        '''<button onclick="ptSetFilter('extension',this)" class="pt-filter-btn">Trace</button>''',
        "process tree filter label (internal filter key left as-is on purpose, only the visible label changes)",
    ),
    (
        "dashboard/install.html",
        '<p class="sub">Your company has added you to their AI data protection system. Installs straight from the Chrome Web Store — takes about 15 seconds.</p>',
        '<p class="sub">Your company has added you to their AI security system. You\'re installing Trace — co|op\'s browser extension — straight from the Chrome Web Store. Takes about 15 seconds.</p>',
        "install page intro",
    ),
    (
        "dashboard/terms.html",
        "<p>co|op is a browser-based data protection tool that detects sensitive information — such as personal identifiers, financial data, and credentials — before it is submitted to third-party AI tools. The Service includes a browser extension, a management dashboard, and related features.</p>",
        "<p>co|op is a browser-based AI security tool that detects sensitive information — such as personal identifiers, financial data, and credentials — before it is submitted to third-party AI tools. The Service includes a browser extension called Trace, a management dashboard, and related features.</p>",
        "terms description",
    ),
    (
        "dashboard/terms.html",
        "<p>co|op is designed so that sensitive text detected by the extension never leaves your browser. We store only metadata about incidents. See our <a href=\"privacy.html\">Privacy Policy</a> for details on what we collect and how it is handled.</p>",
        "<p>co|op is designed so that sensitive text detected by Trace never leaves your browser. We store only metadata about incidents. See our <a href=\"privacy.html\">Privacy Policy</a> for details on what we collect and how it is handled.</p>",
        "terms privacy note",
    ),
]


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: reframe DLP -> AI security, name the extension Trace\n")

    files_touched = {}
    for rel_path, old, new, label in REPLACEMENTS:
        path = REPO_ROOT / rel_path
        if path not in files_touched:
            if not path.exists():
                fail(f"{rel_path} not found")
            files_touched[path] = path.read_text(encoding="utf-8")
        found = files_touched[path].count(old)
        if found != 1:
            fail(f"[{rel_path} / {label}] Expected 1 match, found {found}. File may have changed.")

    for rel_path, old, new, label in REPLACEMENTS:
        path = REPO_ROOT / rel_path
        files_touched[path] = files_touched[path].replace(old, new)

    for path, content in files_touched.items():
        path.write_text(content, encoding="utf-8")

    for rel_path, _, _, label in REPLACEMENTS:
        print(f"\u2713 {rel_path} \u2014 {label}")

    print(f"\n\u2705 Done. {len(REPLACEMENTS)} changes across {len(files_touched)} files.")
    print("Nothing was committed or pushed.")
    print("\nNext: git diff to review, then commit/push yourself.")


if __name__ == "__main__":
    main()
