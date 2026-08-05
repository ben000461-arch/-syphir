#!/usr/bin/env python3
"""
add_password_auth.py

PHASE 1: Closes the live authentication hole — right now /auth/provision-email
hands back a full org's license key to anyone who types their business email,
with zero password check. This adds real password authentication to both
login and signup, plus a safe migration path for existing accounts that were
created before any password existed (confirmed via full-file search: there is
currently NO password_hash logic anywhere live in server.js — the old bcrypt
system referenced in earlier notes has been fully replaced and no longer
exists in the code).

REQUIRED MANUAL STEP BEFORE THIS WILL WORK — run this once in the Supabase
SQL editor (safe/idempotent, no-op if the column already exists):

    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS password_hash text;

This script deliberately does NOT treat password_hash as an optional column
with a silent fallback (unlike phone/signup_status elsewhere in this file) —
if that column is missing, signup will fail loudly with a real error instead
of quietly creating a passwordless account.

WHAT CHANGES:

Server (api/server.js):
  - New validatePasswordLength() helper (min 8 chars)
  - /auth/signup-request now requires + hashes + stores a password
  - /auth/provision-email now requires a password for existing accounts,
    verifies it with Bun.password.verify, and detects "legacy" accounts
    (org exists, approved, but org.password_hash is empty — created before
    this fix existed) — for those, returns {legacy_no_password: true}
    instead of either rejecting them or letting them in unchecked
  - New /auth/set-legacy-password endpoint — lets a legacy account set its
    first password, then logs them straight in

Frontend (dashboard/auth.js):
  - Password field added directly below email on the sign-in screen
  - Password field added on the signup ("tell us about your business") screen,
    with an 8-character client-side check matching the server-side one
  - New "Secure your account" screen shown automatically the first time a
    legacy account (like an existing real org) logs in post-fix

NOT included in this pass (deliberately, per the phased plan): dashboard
Settings password-change UI, and the extra signup fields (business type,
employee count). Those are next.

IMPORTANT — testing limits: this sandbox cannot make live requests to your
Supabase/Render backend, so this script is verified via careful code review,
syntax checks, and structural checks (every referenced element ID exists,
JS parses cleanly, bracket/brace balance) — NOT a live end-to-end test.
After deploying, test for real: try logging into an account that already
exists (like Meridian Legal Group) and confirm you get the "Secure your
account" screen, not an error and not silent access.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_password_auth.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"
AUTH_JS = REPO_ROOT / "dashboard" / "auth.js"

# ═══════════════════════════════════════════════════════════════════════════
# SERVER.JS CHANGES
# ═══════════════════════════════════════════════════════════════════════════

S1_OLD = '''const _rlStore = new Map();
function isRateLimited(c, bucket, max, windowMs) {'''

S1_NEW = '''const _rlStore = new Map();

// Minimum password bar for both signup and legacy-account migration.
// Returns null when valid, or a user-facing error string when not.
function validatePasswordLength(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

function isRateLimited(c, bucket, max, windowMs) {'''

S2_OLD = '''app.post('/auth/provision-email', async (c) => {
  if (isRateLimited(c, "provision-email", 20, 60_000)) return c.json({ error: "Too many attempts. Slow down." }, 429);
  const { email } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);

  const userEmail = email.toLowerCase().trim();

  try {
    // Check if org already exists for this email
    const existing = await db(
      `organizations?admin_email=eq.${encodeURIComponent(userEmail)}&select=*`
    ).catch(() => []);

    if (existing?.length) {
      const org = existing[0];

      // Still waiting on manual approval — don't hand out a key yet.
      if (org.signup_status === 'pending') {
        console.log(`[Auth] Pending signup checked in again: ${userEmail} → org ${org.id}`);
        return c.json({ pending: true, is_new: false, org_id: org.id });
      }
      if (org.signup_status === 'rejected') {
        return c.json({ error: 'This signup was not approved. Contact syphir26@gmail.com for details.' }, 403);
      }

      const keys = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
      ).catch(() => []);
      const key = keys?.[0]?.key;
      if (!key) return c.json({ error: 'No active key found. Contact support.' }, 404);

      console.log(`[Auth] Returning user (email): ${userEmail} → org ${org.id}`);
      return c.json({ key, org_name: org.name, org_id: org.id, plan: org.plan, is_new: false });
    }

    // No org for this email yet — tell the frontend to collect a couple more
    // details before we create anything. Nothing is written to the DB here.
    return c.json({ exists: false });

  } catch(err) {
    console.error('[Auth] provision-email error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── AUTH: Submit a trial request — creates a PENDING org, no dashboard access yet ──
// Trial + keys only activate once approved from the admin panel.
app.post('/auth/signup-request', async (c) => {
  if (isRateLimited(c, "signup-request", 10, 60_000)) return c.json({ error: "Too many attempts. Try again shortly." }, 429);
  const { email, business_name, phone } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);
  if (!business_name || !business_name.trim()) return c.json({ error: 'Business name required' }, 400);'''

S2_NEW = '''app.post('/auth/provision-email', async (c) => {
  if (isRateLimited(c, "provision-email", 20, 60_000)) return c.json({ error: "Too many attempts. Slow down." }, 429);
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);

  const userEmail = email.toLowerCase().trim();

  try {
    // Check if org already exists for this email
    const existing = await db(
      `organizations?admin_email=eq.${encodeURIComponent(userEmail)}&select=*`
    ).catch(() => []);

    if (existing?.length) {
      const org = existing[0];

      // Still waiting on manual approval — don't hand out a key yet.
      if (org.signup_status === 'pending') {
        console.log(`[Auth] Pending signup checked in again: ${userEmail} → org ${org.id}`);
        return c.json({ pending: true, is_new: false, org_id: org.id });
      }
      if (org.signup_status === 'rejected') {
        return c.json({ error: 'This signup was not approved. Contact syphir26@gmail.com for details.' }, 403);
      }

      // Account predates password auth entirely — walk them through setting
      // one now instead of either rejecting them or letting them straight in.
      if (!org.password_hash) {
        return c.json({ legacy_no_password: true, org_id: org.id });
      }
      if (!password) return c.json({ error: 'Password required.' }, 400);
      const passwordOk = await Bun.password.verify(password, org.password_hash);
      if (!passwordOk) return c.json({ error: 'Incorrect password.' }, 401);

      const keys = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
      ).catch(() => []);
      const key = keys?.[0]?.key;
      if (!key) return c.json({ error: 'No active key found. Contact support.' }, 404);

      console.log(`[Auth] Returning user (email): ${userEmail} → org ${org.id}`);
      return c.json({ key, org_name: org.name, org_id: org.id, plan: org.plan, is_new: false });
    }

    // No org for this email yet — tell the frontend to collect a couple more
    // details before we create anything. Nothing is written to the DB here.
    return c.json({ exists: false });

  } catch(err) {
    console.error('[Auth] provision-email error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── AUTH: Set a first password for a "legacy" account (created before ──────
// password auth existed, so it has no password_hash on file yet). Verifies
// the account is real and approved, hashes + stores the password, then logs
// them straight in — same response shape as a normal successful login.
app.post('/auth/set-legacy-password', async (c) => {
  if (isRateLimited(c, "set-legacy-password", 10, 60_000)) return c.json({ error: "Too many attempts. Try again shortly." }, 429);
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);
  const pwErr = validatePasswordLength(password);
  if (pwErr) return c.json({ error: pwErr }, 400);

  const userEmail = email.toLowerCase().trim();

  try {
    const existing = await db(
      `organizations?admin_email=eq.${encodeURIComponent(userEmail)}&select=*`
    ).catch(() => []);
    if (!existing?.length) return c.json({ error: 'No account found for this email.' }, 404);

    const org = existing[0];
    if (org.signup_status === 'pending') return c.json({ pending: true }, 200);
    if (org.signup_status === 'rejected') {
      return c.json({ error: 'This signup was not approved. Contact syphir26@gmail.com for details.' }, 403);
    }
    if (org.password_hash) {
      return c.json({ error: 'This account already has a password set. Use the sign-in form.' }, 409);
    }

    const passwordHash = await Bun.password.hash(password);
    await db(`organizations?id=eq.${encodeURIComponent(org.id)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ password_hash: passwordHash }),
    });

    const keys = await db(
      `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
    ).catch(() => []);
    const key = keys?.[0]?.key;
    if (!key) return c.json({ error: 'No active key found. Contact support.' }, 404);

    console.log(`[Auth] Legacy password set: ${userEmail} → org ${org.id}`);
    return c.json({ key, org_name: org.name, org_id: org.id, plan: org.plan });

  } catch(err) {
    console.error('[Auth] set-legacy-password error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── AUTH: Submit a trial request — creates a PENDING org, no dashboard access yet ──
// Trial + keys only activate once approved from the admin panel.
app.post('/auth/signup-request', async (c) => {
  if (isRateLimited(c, "signup-request", 10, 60_000)) return c.json({ error: "Too many attempts. Try again shortly." }, 429);
  const { email, business_name, phone, password } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);
  if (!business_name || !business_name.trim()) return c.json({ error: 'Business name required' }, 400);
  const pwErr = validatePasswordLength(password);
  if (pwErr) return c.json({ error: pwErr }, 400);'''

S3_OLD = '''    const bizKey = genKey();
    const empKey = genEmpKey();

    // Create the org. If the optional signup_status/phone columns aren't in the
    // schema yet, fall back to a minimal insert so signup still works.
    let newOrg;
    try {
      newOrg = await db('organizations', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          name: orgName, admin_email: userEmail, phone: userPhone, plan: 'Demo',
          active: false, signup_status: 'pending',
        }),
      });
    } catch (colErr) {
      console.warn('[Auth] Full org insert failed, retrying minimal:', colErr.message);
      newOrg = await db('organizations', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          name: orgName, admin_email: userEmail, plan: 'Demo', active: false,
        }),
      });
    }'''

S3_NEW = '''    const bizKey = genKey();
    const empKey = genEmpKey();
    const passwordHash = await Bun.password.hash(password);

    // Create the org. If the optional signup_status/phone columns aren't in the
    // schema yet, fall back to a minimal insert so signup still works.
    // password_hash is deliberately NOT treated as droppable here like phone/
    // signup_status are — if that column is missing this should fail loudly
    // rather than silently create a passwordless account.
    let newOrg;
    try {
      newOrg = await db('organizations', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          name: orgName, admin_email: userEmail, phone: userPhone, plan: 'Demo',
          active: false, signup_status: 'pending', password_hash: passwordHash,
        }),
      });
    } catch (colErr) {
      console.warn('[Auth] Full org insert failed, retrying minimal:', colErr.message);
      newOrg = await db('organizations', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          name: orgName, admin_email: userEmail, plan: 'Demo', active: false,
          password_hash: passwordHash,
        }),
      });
    }'''

SERVER_REPLACEMENTS = [
    (S1_OLD, S1_NEW),
    (S2_OLD, S2_NEW),
    (S3_OLD, S3_NEW),
]

# ═══════════════════════════════════════════════════════════════════════════
# AUTH.JS CHANGES
# ═══════════════════════════════════════════════════════════════════════════

A1_OLD = '''      <!-- Email -->
      <div class="field">
        <label>Business email</label>
        <input type="email" id="magicEmail" placeholder="you@company.com" autocomplete="email"/>
      </div>
      <div class="err-msg" id="magicErr"></div>
      <button class="modal-btn" onclick="authContinue()" id="magicBtn">Continue →</button>'''

A1_NEW = '''      <!-- Email -->
      <div class="field">
        <label>Business email</label>
        <input type="email" id="magicEmail" placeholder="you@company.com" autocomplete="email"/>
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" id="magicPassword" placeholder="••••••••" autocomplete="current-password"/>
      </div>
      <div class="err-msg" id="magicErr"></div>
      <button class="modal-btn" onclick="authContinue()" id="magicBtn">Continue →</button>'''

A2_OLD = '''      <div class="field">
        <label>Phone number</label>
        <input type="tel" id="detailsPhone" placeholder="(555) 123-4567" autocomplete="tel"/>
      </div>
      <div class="err-msg" id="detailsErr"></div>
      <button class="modal-btn" onclick="submitSignupDetails()" id="detailsBtn">Request Trial →</button>'''

A2_NEW = '''      <div class="field">
        <label>Phone number</label>
        <input type="tel" id="detailsPhone" placeholder="(555) 123-4567" autocomplete="tel"/>
      </div>
      <div class="field">
        <label>Create a password</label>
        <input type="password" id="detailsPassword" placeholder="At least 8 characters" autocomplete="new-password"/>
      </div>
      <div class="err-msg" id="detailsErr"></div>
      <button class="modal-btn" onclick="submitSignupDetails()" id="detailsBtn">Request Trial →</button>'''

A3_OLD = '''      <div style="text-align:center;margin-top:14px;font-size:11.5px;color:#475569;">
        Still stuck? Email us at <a href="mailto:syphir26@gmail.com" style="color:#6366f1;text-decoration:none;">syphir26@gmail.com</a>
      </div>
    </div>

  </div>
</div>
`;'''

A3_NEW = '''      <div style="text-align:center;margin-top:14px;font-size:11.5px;color:#475569;">
        Still stuck? Email us at <a href="mailto:syphir26@gmail.com" style="color:#6366f1;text-decoration:none;">syphir26@gmail.com</a>
      </div>
    </div>

    <!-- ── SET PASSWORD panel (legacy accounts with no password on file) ── -->
    <div id="pane-set-password" style="display:none;">
      <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px;">Secure your account</h2>
      <p class="modal-sub" style="margin-bottom:16px;line-height:1.55;">We've added password protection to co|op accounts. Set a password now to continue — you'll use it to sign in from here on.</p>
      <div class="field">
        <label>New password</label>
        <input type="password" id="setPwField" placeholder="At least 8 characters" autocomplete="new-password"/>
        <div class="err-msg" id="setPwErr"></div>
      </div>
      <button class="modal-btn" onclick="setLegacyPassword()" id="setPwBtn">Set Password & Continue →</button>
    </div>

  </div>
</div>
`;'''

A4_OLD = '''function showPane(id) {
  ['pane-main','pane-details','pane-submitted','pane-key','pane-forgot'].forEach(p => {'''

A4_NEW = '''function showPane(id) {
  ['pane-main','pane-details','pane-submitted','pane-key','pane-forgot','pane-set-password'].forEach(p => {'''

A5_OLD = '''async function authContinue() {
  const emailField = document.getElementById('magicEmail');
  const email = (emailField?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    showModalErr('Enter a valid business email.', 'magicErr');
    return;
  }
  const btn = document.getElementById('magicBtn');
  const err = document.getElementById('magicErr');
  const succ = document.getElementById('magicSuccess');
  btn.disabled = true;
  btn.textContent = 'Continuing…';
  if (err) err.textContent = '';
  if (succ) succ.style.display = 'none';

  try {
    const r = await fetchWithTimeout(`${API}/auth/provision-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await r.json();
    btn.disabled = false;
    btn.textContent = 'Continue →';

    if (!r.ok || data.error) {
      showModalErr(data.error || 'Could not connect. Try again in a moment.', 'magicErr');
      return;
    }

    if (data.exists === false) {
      // Brand new email — collect a couple more details before we create anything.
      _pendingSignupEmail = email;
      try { localStorage.setItem('syphir_remembered_email', email); } catch(_) {}
      const emailPreview = document.getElementById('detailsEmailPreview');
      if (emailPreview) emailPreview.textContent = email;
      showPane('pane-details');
      setTimeout(() => document.getElementById('detailsBizName')?.focus(), 100);
      return;
    }

    if (data.pending) {'''

A5_NEW = '''async function authContinue() {
  const emailField = document.getElementById('magicEmail');
  const email = (emailField?.value || '').trim().toLowerCase();
  const password = document.getElementById('magicPassword')?.value || '';
  if (!email || !email.includes('@')) {
    showModalErr('Enter a valid business email.', 'magicErr');
    return;
  }
  const btn = document.getElementById('magicBtn');
  const err = document.getElementById('magicErr');
  const succ = document.getElementById('magicSuccess');
  btn.disabled = true;
  btn.textContent = 'Continuing…';
  if (err) err.textContent = '';
  if (succ) succ.style.display = 'none';

  try {
    const r = await fetchWithTimeout(`${API}/auth/provision-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    btn.disabled = false;
    btn.textContent = 'Continue →';

    if (!r.ok || data.error) {
      showModalErr(data.error || 'Could not connect. Try again in a moment.', 'magicErr');
      return;
    }

    if (data.exists === false) {
      // Brand new email — collect a couple more details before we create anything.
      _pendingSignupEmail = email;
      try { localStorage.setItem('syphir_remembered_email', email); } catch(_) {}
      const emailPreview = document.getElementById('detailsEmailPreview');
      if (emailPreview) emailPreview.textContent = email;
      showPane('pane-details');
      setTimeout(() => document.getElementById('detailsBizName')?.focus(), 100);
      return;
    }

    if (data.legacy_no_password) {
      // Account exists from before password auth existed — walk them through
      // setting one now instead of rejecting them or letting them straight in.
      _pendingSignupEmail = email;
      showPane('pane-set-password');
      setTimeout(() => document.getElementById('setPwField')?.focus(), 100);
      return;
    }

    if (data.pending) {'''

A6_OLD = '''async function submitSignupDetails() {
  const bizName = (document.getElementById('detailsBizName')?.value || '').trim();
  const phone   = (document.getElementById('detailsPhone')?.value || '').trim();
  const err     = document.getElementById('detailsErr');
  const btn     = document.getElementById('detailsBtn');

  if (!bizName) {
    if (err) err.textContent = 'Enter your business name.';
    return;
  }
  if (!_pendingSignupEmail) {
    // Safety net — shouldn't happen, but don't let them submit with no email.
    showPane('pane-main');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Submitting…';
  if (err) err.textContent = '';

  try {
    const r = await fetchWithTimeout(`${API}/auth/signup-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingSignupEmail, business_name: bizName, phone }),
    });
    const data = await r.json().catch(() => ({}));
    btn.disabled = false;
    btn.textContent = 'Request Trial →';

    if (!r.ok || data.error) {
      if (err) err.textContent = data.error || `Something went wrong (${r.status}). Try again in a moment.`;
      return;
    }

    // Success — show the dedicated "trial under review" welcome screen.
    showPane('pane-submitted');
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Request Trial →';
    console.error('co|op: submitSignupDetails failed:', e);
    if (err) err.textContent = e.name === 'AbortError'
      ? 'Still connecting — our server may be waking up. Try again in a few seconds.'
      : 'Could not connect. Try again in a moment.';
  }
}

// ── License key login ─────────────────────────────────────────────────────────'''

A6_NEW = '''async function submitSignupDetails() {
  const bizName = (document.getElementById('detailsBizName')?.value || '').trim();
  const phone   = (document.getElementById('detailsPhone')?.value || '').trim();
  const password = document.getElementById('detailsPassword')?.value || '';
  const err     = document.getElementById('detailsErr');
  const btn     = document.getElementById('detailsBtn');

  if (!bizName) {
    if (err) err.textContent = 'Enter your business name.';
    return;
  }
  if (password.length < 8) {
    if (err) err.textContent = 'Password must be at least 8 characters.';
    return;
  }
  if (!_pendingSignupEmail) {
    // Safety net — shouldn't happen, but don't let them submit with no email.
    showPane('pane-main');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Submitting…';
  if (err) err.textContent = '';

  try {
    const r = await fetchWithTimeout(`${API}/auth/signup-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingSignupEmail, business_name: bizName, phone, password }),
    });
    const data = await r.json().catch(() => ({}));
    btn.disabled = false;
    btn.textContent = 'Request Trial →';

    if (!r.ok || data.error) {
      if (err) err.textContent = data.error || `Something went wrong (${r.status}). Try again in a moment.`;
      return;
    }

    // Success — show the dedicated "trial under review" welcome screen.
    showPane('pane-submitted');
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Request Trial →';
    console.error('co|op: submitSignupDetails failed:', e);
    if (err) err.textContent = e.name === 'AbortError'
      ? 'Still connecting — our server may be waking up. Try again in a few seconds.'
      : 'Could not connect. Try again in a moment.';
  }
}

// ── Set password for a legacy (pre-password) account ──────────────────────────
async function setLegacyPassword() {
  const password = document.getElementById('setPwField')?.value || '';
  const err = document.getElementById('setPwErr');
  const btn = document.getElementById('setPwBtn');

  if (password.length < 8) {
    if (err) err.textContent = 'Password must be at least 8 characters.';
    return;
  }
  if (!_pendingSignupEmail) {
    showPane('pane-main');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Setting password…';
  if (err) err.textContent = '';

  try {
    const r = await fetchWithTimeout(`${API}/auth/set-legacy-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: _pendingSignupEmail, password }),
    });
    const data = await r.json().catch(() => ({}));
    btn.disabled = false;
    btn.textContent = 'Set Password & Continue →';

    if (!r.ok || data.error) {
      if (err) err.textContent = data.error || 'Could not connect. Try again in a moment.';
      return;
    }

    if (data.pending) {
      showPane('pane-main');
      return;
    }

    saveSession({ key: data.key, org_name: data.org_name, org_id: data.org_id, email: _pendingSignupEmail }, true);
    goToDashboard(data.key, data.org_name);
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Set Password & Continue →';
    if (err) err.textContent = e.name === 'AbortError'
      ? 'Still connecting — our server may be waking up. Try again in a few seconds.'
      : 'Could not connect. Try again in a moment.';
  }
}

// ── License key login ─────────────────────────────────────────────────────────'''

A7_OLD = '''  document.getElementById('magicEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') authContinue();
  });
  document.getElementById('detailsBizName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });
  document.getElementById('detailsPhone')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });'''

A7_NEW = '''  document.getElementById('magicEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') authContinue();
  });
  document.getElementById('magicPassword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') authContinue();
  });
  document.getElementById('detailsBizName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });
  document.getElementById('detailsPhone')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });
  document.getElementById('detailsPassword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });
  document.getElementById('setPwField')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') setLegacyPassword();
  });'''

AUTH_REPLACEMENTS = [
    (A1_OLD, A1_NEW),
    (A2_OLD, A2_NEW),
    (A3_OLD, A3_NEW),
    (A4_OLD, A4_NEW),
    (A5_OLD, A5_NEW),
    (A6_OLD, A6_NEW),
    (A7_OLD, A7_NEW),
]


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def apply_replacements(path, replacements, label):
    if not path.exists():
        fail(f"{path} not found")
    content = path.read_text(encoding="utf-8")

    for i, (old, new) in enumerate(replacements, 1):
        found = content.count(old)
        if found != 1:
            fail(
                f"[{label}] Expected exactly 1 match for replacement #{i} "
                f"(starting: {old[:70]!r}...) but found {found}. "
                f"File may have changed since this script was written."
            )

    for old, new in replacements:
        content = content.replace(old, new)

    path.write_text(content, encoding="utf-8")
    print(f"\u2713 {path.relative_to(REPO_ROOT)} updated ({len(replacements)} changes)")


def main():
    print("co|op: add password authentication (Phase 1)\n")
    apply_replacements(SERVER_JS, SERVER_REPLACEMENTS, "server.js")
    apply_replacements(AUTH_JS, AUTH_REPLACEMENTS, "auth.js")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\n\u26a0\ufe0f  BEFORE YOU DEPLOY — run this once in the Supabase SQL editor:")
    print("   ALTER TABLE organizations ADD COLUMN IF NOT EXISTS password_hash text;")
    print("   (safe to run even if it already exists)")
    print("\nNext:")
    print("1. Review: git diff api/server.js dashboard/auth.js")
    print("2. Run the SQL above in Supabase FIRST")
    print("3. Commit + push")
    print("4. Test for real: try logging into an existing account (e.g. Meridian")
    print("   Legal Group's admin email) and confirm you land on 'Secure your")
    print("   account' instead of getting in with no password, or getting an error.")


if __name__ == "__main__":
    main()
