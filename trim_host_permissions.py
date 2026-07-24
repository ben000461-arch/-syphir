#!/usr/bin/env python3
"""
trim_host_permissions.py

Removes host_permissions entries that have no matching content_scripts
coverage - i.e. permissions the extension holds but doesn't actually use.
Also removes the http://localhost:3000/* dev leftover.

Why: Chrome Web Store review checks that every permission has a
demonstrable use in the extension's actual behavior. Unused permissions
are a common rejection reason, and Google's tightened data-handling policy
(enforcement starts Aug 1, 2026) makes this stricter, not looser.

None of the removed domains are covered by content_scripts today, and none
are among the six tools co|op actually advertises (ChatGPT, Claude, Gemini,
Copilot, Grok, Perplexity) - all six keep their permissions untouched.

This script parses manifest.json as JSON (not raw text) so there's no risk
of comma/formatting mistakes - it loads the array, removes the exact
entries below, and writes it back with the same 2-space indent style.

Safe to re-run: if an entry is already gone, it's just skipped.

Usage:
    cd /path/to/-syphir     # repo root
    python3 trim_host_permissions.py
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
MANIFEST_PATH = REPO_ROOT / "extension" / "manifest.json"

# Domains present in host_permissions with no matching content_scripts entry,
# plus the dev-only localhost permission.
TO_REMOVE = [
    "https://playground.ai/*",
    "https://together.ai/*",
    "https://api.together.xyz/*",
    "https://fireworks.ai/*",
    "https://app.fireworks.ai/*",
    "https://replicate.com/*",
    "https://hailuoai.com/*",
    "https://www.hailuoai.com/*",
    "https://kimi.moonshot.cn/*",
    "https://www.kimi.ai/*",
    "https://chat.qwen.ai/*",
    "https://tongyi.aliyun.com/*",
    "https://yiyan.baidu.com/*",
    "https://xinghuo.xfyun.cn/*",
    "https://www.doubao.com/*",
    "https://llama.meta.com/*",
    "http://localhost:3000/*",
]


def fail(msg):
    print(f"\n❌ ABORTED: {msg}")
    print("Nothing was written. Fix the issue above and re-run.")
    sys.exit(1)


def main():
    print("co|op host_permissions trim")
    print(f"Repo root: {REPO_ROOT}\n")

    if not MANIFEST_PATH.exists():
        fail(f"manifest.json not found at {MANIFEST_PATH}. Run this from the repo root.")

    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"manifest.json isn't valid JSON right now: {e}")

    if "host_permissions" not in manifest:
        fail('manifest.json has no "host_permissions" key - unexpected shape, stopping.')

    before = manifest["host_permissions"]
    before_count = len(before)

    already_gone = [d for d in TO_REMOVE if d not in before]
    if already_gone:
        print(f"  → {len(already_gone)} of the target domain(s) already removed, skipping those")

    after = [d for d in before if d not in TO_REMOVE]
    removed_count = before_count - len(after)

    if removed_count == 0:
        print("  → nothing to remove, already trimmed. Skipping.")
        return

    manifest["host_permissions"] = after

    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"  ✓ host_permissions: {before_count} -> {len(after)} entries "
          f"({removed_count} removed)")
    print(f"  ✓ manifest.json updated ({MANIFEST_PATH.stat().st_size} bytes)")

    print("\n✅ Done. Nothing was committed or pushed.")
    print("Next: run `git status` / `git diff` to review, then commit/push yourself.")


if __name__ == "__main__":
    main()
