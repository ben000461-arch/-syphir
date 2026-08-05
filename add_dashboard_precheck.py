#!/usr/bin/env python3
"""
add_dashboard_precheck.py

Right now, clicking "Open Dashboard" from the profile menu (on index.html
or any page using the shared nav) navigates straight to app.html using
whatever session is cached locally - it only discovers the trial has
expired *after* that navigation, once app.html does its own check. That
means a full page load just to arrive at a paywall.

This adds a check before the navigation happens: validate the key first,
and if it's expired, show the same trial-expired overlay card right on
the current page - no navigation to app.html at all. If it's still valid,
proceed to app.html exactly as before.

NOTE ON DUPLICATION (deliberate, not accidental): app.html doesn't load
auth.js, and auth.js doesn't load app.html's code - they're separate
today. Rather than restructure that tonight, this adds its own self-
contained copy of the trial-expired card to auth.js, using different
internal names (startTrialCheckout / trial-checkout-msg) than app.html's
version (startCheckout / checkout-msg) specifically so the two can never
collide if they ever end up loaded on the same page. If the two versions
ever need to be unified into one shared source, that's a separate,
bigger task - flagged here so it's a known tradeoff, not a silent one.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_dashboard_precheck.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
AUTH_JS = REPO_ROOT / "dashboard" / "auth.js"

OLD_GOTODASH = """function goToDashboard(key, orgName) {
  closeModal();
  window.location.href = `app.html?key=${encodeURIComponent(key)}&org=${encodeURIComponent(orgName || '')}`;
}"""

NEW_FUNCTIONS_BLOCK = """

// \u2500\u2500 Shared trial-expired overlay \u2500\u2500 shown when "Open Dashboard" is clicked with a
// cached session whose trial has actually expired. Same card app.html shows,
// but right here, without navigating away first. Uses its own internal
// names (startTrialCheckout / trial-checkout-msg) so it can never collide
// with app.html's separate copy of this same card.
function showTrialExpiredOverlay(key) {
  document.body.style.overflow = 'hidden';
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;background:rgba(5,8,15,0.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;padding:20px;z-index:9999;"><div style="background:#161b25;border:1px solid #242d3e;border-radius:16px;padding:48px 40px;max-width:480px;width:100%;text-align:center;"><div style="font-size:52px;margin-bottom:20px;">&#128274;</div><h1 style="font-size:22px;font-weight:800;color:#e6edf3;margin:0 0 12px;">Your 7-day free trial has ended</h1><p style="font-size:14px;color:#8b949e;line-height:1.6;margin:0 0 28px;">Upgrade to keep your team's AI activity protected.</p><div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;"><button onclick="startTrialCheckout('Starter')" style="background:#1c2333;border:1px solid #2d3a50;color:#e6edf3;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;display:flex;justify-content:space-between;align-items:center;"><span>Starter</span><span style="color:#4db8f0;font-weight:700;">$129/mo</span></button><button onclick="startTrialCheckout('Professional')" style="background:#2196d3;border:none;color:#fff;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:Inter,sans-serif;display:flex;justify-content:space-between;align-items:center;"><span>Professional Most Popular</span><span>$299/mo</span></button><button onclick="startTrialCheckout('Institution')" style="background:#1c2333;border:1px solid #2d3a50;color:#e6edf3;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;display:flex;justify-content:space-between;align-items:center;"><span>Institution</span><span style="color:#4db8f0;font-weight:700;">$599/mo</span></button></div><div id="trial-checkout-msg" style="font-size:12px;color:#8b949e;min-height:18px;margin-bottom:12px;"></div><a href="mailto:syphir26@gmail.com" style="display:block;font-size:12px;color:#4a5568;text-decoration:none;">Questions? Email syphir26@gmail.com</a></div></div>`);

  window.startTrialCheckout = async (plan) => {
    const msg = document.getElementById('trial-checkout-msg');
    if (msg) msg.textContent = 'Redirecting to checkout...';
    try {
      const r = await fetch(`${API}/create-checkout-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, plan }),
      });
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else if (msg) { msg.style.color = '#f44336'; msg.textContent = d.error || 'Could not start checkout'; }
    } catch(e) {
      if (msg) { msg.style.color = '#f44336'; msg.textContent = 'Network error \u2014 try again'; }
    }
  };
}

// \u2500\u2500 "Open Dashboard" from a cached session \u2500\u2500 checks it's still valid FIRST instead
// of navigating to app.html blindly and finding out there. If the trial
// expired since this session was saved, shows the overlay right here.
async function openDashboardChecked(key, orgName) {
  try {
    const r = await fetch(`${API}/validate-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, context: 'dashboard' }),
    });
    const data = await r.json();
    if (data.valid) {
      goToDashboard(key, orgName);
    } else if (data.expired) {
      closeModal();
      showTrialExpiredOverlay(key);
    } else {
      // Key no longer valid at all (revoked, etc.) \u2014 safest is to sign out
      // and let them re-authenticate normally rather than guess further.
      clearSession();
      renderNavAuthState();
      openModal();
    }
  } catch(e) {
    // Network hiccup \u2014 fall back to normal navigation rather than blocking
    // them entirely; app.html's own check will still catch it from there.
    goToDashboard(key, orgName);
  }
}"""

# The Open Dashboard link uses tricky nested JS-string escaping that's very
# easy to get subtly wrong by hand-typing it a second time. Instead of
# retyping the whole line, find it in the file and do a small, targeted
# substitution on the exact text that's actually there.
LINK_OLD_CALL = 'onclick="goToDashboard('
LINK_NEW_CALL = 'onclick="openDashboardChecked('


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op: check trial status before navigating to dashboard\n")

    if not AUTH_JS.exists():
        fail(f"dashboard/auth.js not found at {AUTH_JS}")

    content = AUTH_JS.read_text(encoding="utf-8")

    if content.count(OLD_GOTODASH) != 1:
        fail(f"Expected 1 match for goToDashboard(), found {content.count(OLD_GOTODASH)}. File may have changed.")

    # Find the profile-dropdown link line specifically (the one with
    # session.key in it - handleKey()'s button also says "Open Dashboard"
    # but doesn't call goToDashboard(), so this combination is unique to it).
    lines = content.split("\n")
    target_line_idx = None
    for i, line in enumerate(lines):
        if LINK_OLD_CALL in line and "session.key" in line:
            target_line_idx = i
            break

    if target_line_idx is None:
        fail('Could not find the profile-dropdown "Open Dashboard" link '
             '(onclick="goToDashboard(...)" with session.key). File may have changed.')

    if lines[target_line_idx].count(LINK_OLD_CALL) != 1:
        fail("Expected exactly 1 occurrence of the onclick call on that line.")

    lines[target_line_idx] = lines[target_line_idx].replace(LINK_OLD_CALL, LINK_NEW_CALL)
    content = "\n".join(lines)
    content = content.replace(OLD_GOTODASH, OLD_GOTODASH + NEW_FUNCTIONS_BLOCK)

    AUTH_JS.write_text(content, encoding="utf-8")
    print(f"\u2713 dashboard/auth.js updated")
    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: git diff dashboard/auth.js to review, then commit/push yourself.")
    print("\nTo test: with a saved session for an expired-trial org, click your")
    print("profile icon > Open Dashboard from index.html - the card should now")
    print("appear right there, with no navigation to app.html at all.")


if __name__ == "__main__":
    main()
