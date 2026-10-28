#!/usr/bin/env python3
"""
add_webhook_debug_log.py

TEMPORARY diagnostic - adds one safe log line right before the webhook
signature check. This doesn't print the real secret anywhere, just
enough shape information to know definitively what the running server
actually has loaded, instead of continuing to guess or eyeball-compare
strings:
  - whether STRIPE_WEBHOOK_SECRET is set at all
  - its length and first/last 4 characters (enough to spot a truncated
    copy-paste or a completely empty value, not enough to reconstruct
    the real secret)
  - whether Stripe's signature header actually arrived
  - the raw body length received

This narrows the problem down to one of two categories immediately:
  - secret length is 0, or first/last chars look wrong -> the env var
    isn't set correctly on Render (wrong name, didn't save, wrong
    service, etc.)
  - secret looks correct and full-length, but verification STILL fails
    -> something deeper (raw body integrity, runtime quirk) - a
    different, smaller class of problem to chase next

Meant to be removed once the real cause is found - not a permanent
change. A follow-up script will clean this line out afterward.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_webhook_debug_log.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"

OLD = '''app.post("/stripe-webhook", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const sig = c.req.header("stripe-signature");
  const rawBody = await c.req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return c.text("Webhook signature invalid", 400);
  }'''

NEW = '''app.post("/stripe-webhook", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const sig = c.req.header("stripe-signature");
  const rawBody = await c.req.text();

  // TEMPORARY DEBUG - safe, doesn't print the real secret
  const _secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  console.log("[Webhook Debug] secret length:", _secret.length,
    "| starts:", _secret.slice(0, 4), "| ends:", _secret.slice(-4),
    "| sig header present:", !!sig, "| sig header length:", (sig || "").length,
    "| body length:", rawBody.length);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, _secret);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return c.text("Webhook signature invalid", 400);
  }'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: add TEMPORARY webhook debug logging\n")

    if not SERVER_JS.exists():
        fail(f"api/server.js not found at {SERVER_JS}")

    content = SERVER_JS.read_text(encoding="utf-8")
    if content.count(OLD) != 1:
        fail(f"Expected 1 match, found {content.count(OLD)}. File may have changed.")

    content = content.replace(OLD, NEW)
    SERVER_JS.write_text(content, encoding="utf-8")

    print("\u2713 api/server.js updated with temporary debug logging")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext:")
    print("1. git add api/server.js && git commit -m 'Temp: debug webhook secret' && git push")
    print("2. Wait for Render to redeploy")
    print("3. Go back to Stripe's Event deliveries list and click Resend on one")
    print("   of the failed events again")
    print("4. Immediately check Render's Logs tab for a line starting with")
    print("   '[Webhook Debug]' - paste that exact line back")
    print("\nRemember: this is temporary. Once we find the real cause, remove this")
    print("log line before it ships for real - it's fine for a few minutes of")
    print("debugging, not for production.")


if __name__ == "__main__":
    main()
