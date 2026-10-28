#!/usr/bin/env python3
"""
fix_webhook_async_verification.py

THE REAL FIX. Every failed webhook tonight had the same root cause,
confirmed directly by Stripe's own SDK error message:

    "SubtleCryptoProvider cannot be used in a synchronous context.
    Use `await constructEventAsync(...)` instead of `constructEvent(...)`"

This has nothing to do with the signing secret, the endpoint URL, or
the event type - all of those were confirmed correct via the temporary
debug log (secret length 38, correct prefix/suffix, signature header
present, real body content). The actual problem: Stripe's SDK offers
two ways to verify a webhook signature - a synchronous one and an
async one - and the synchronous one depends on a crypto API that
doesn't work the same way in Bun (this server's runtime) as it does in
Node. Stripe's SDK builds specifically for this and exposes
constructEventAsync() for exactly this situation.

This script:
  1. Switches constructEvent() -> await constructEventAsync() - the
     real fix.
  2. Removes the temporary debug logging added earlier tonight - it
     did its job (told us exactly what was wrong), no reason to keep
     printing secret-shape info to production logs going forward.

Usage:
    cd /path/to/-syphir     # repo root
    python3 fix_webhook_async_verification.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"

OLD = '''app.post("/stripe-webhook", async (c) => {
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

NEW = '''app.post("/stripe-webhook", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const sig = c.req.header("stripe-signature");
  const rawBody = await c.req.text();

  let event;
  try {
    // constructEventAsync (not constructEvent) - Bun's crypto implementation
    // requires the async verification path; the sync one throws
    // "SubtleCryptoProvider cannot be used in a synchronous context" here.
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return c.text("Webhook signature invalid", 400);
  }'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: fix webhook signature verification (sync -> async for Bun)\n")

    if not SERVER_JS.exists():
        fail(f"api/server.js not found at {SERVER_JS}")

    content = SERVER_JS.read_text(encoding="utf-8")
    if content.count(OLD) != 1:
        fail(f"Expected 1 match, found {content.count(OLD)}. File may have changed since this script was written.")

    content = content.replace(OLD, NEW)
    SERVER_JS.write_text(content, encoding="utf-8")

    print("\u2713 api/server.js updated:")
    print("  - constructEvent() -> await constructEventAsync() (the real fix)")
    print("  - temporary debug logging removed")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext:")
    print("1. git diff api/server.js")
    print("2. git add api/server.js && git commit -m 'Fix webhook verification - use async for Bun' && git push")
    print("3. Wait for Render to redeploy")
    print("4. Go back to Stripe's Event deliveries list, click Resend on the failed")
    print("   event one more time - this should finally show a 200, not 400")
    print("5. Once confirmed working, go check your test org's dashboard - it should")
    print("   now show as upgraded/active instead of the expired-trial screen")


if __name__ == "__main__":
    main()
