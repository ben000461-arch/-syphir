// ── CO|OP AUTH ───────────────────────────────────────────────────────────────
const API = 'https://syphir-api.onrender.com';

// ── SHARED AUTH MODAL ─────────────────────────────────────────────────────────
// Single source of truth for the login/signup modal — injected into every page
// that has an empty <div id="authModalMount"></div>. Edit the markup here once
// and it's live everywhere; no more hand-syncing copies across HTML files.
const AUTH_MODAL_HTML = `
<div class="modal-overlay" id="loginModal">
  <div class="modal" style="max-width:400px;">
    <button class="modal-close" onclick="closeModal()">✕</button>
    <div class="modal-logo">
      <span class="coop-logo" style="font-size:1.3rem;">co<span class="bar">|</span>op</span>
    </div>

    <!-- ── MAIN panel ── -->
    <div id="pane-main">
      <h2 style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">Sign in or create your account</h2>
      <p class="modal-sub" style="margin-bottom:20px;">New here? Request a free 7-day trial — we review every signup personally, no credit card required.</p>

      <!-- Email -->
      <div class="field">
        <label>Business email</label>
        <input type="email" id="magicEmail" placeholder="you@company.com" autocomplete="email"/>
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" id="magicPassword" placeholder="••••••••" autocomplete="current-password"/>
      </div>
      <div class="err-msg" id="magicErr"></div>
      <button class="modal-btn" onclick="authContinue()" id="magicBtn">Continue →</button>

      <div id="magicSuccess" style="display:none;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:7px;padding:11px 13px;margin-top:10px;font-size:12px;color:#3ecf8e;line-height:1.5;">
        ✓ Got it — we review every signup personally. You'll get an email with your dashboard key once it's approved (usually within a day).
      </div>

      <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:11.5px;">
        <a href="#" onclick="showPane('pane-key');return false;" style="color:#6366f1;text-decoration:none;">Use license key instead</a>
        <a href="#" onclick="showPane('pane-forgot');return false;" style="color:#475569;text-decoration:none;">Forgot everything?</a>
      </div>
    </div>

    <!-- ── DETAILS panel (new signup) ── -->
    <div id="pane-details" style="display:none;">
      <button onclick="showPane('pane-main')" style="background:none;border:none;color:#475569;font-size:12px;cursor:pointer;margin-bottom:14px;padding:0;font-family:inherit;">← Back</button>
      <h2 style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">Tell us about your business</h2>
      <p class="modal-sub" style="margin-bottom:16px;">Signing up as <strong id="detailsEmailPreview" style="color:#fff;"></strong></p>

      <div class="field">
        <label>Business name</label>
        <input type="text" id="detailsBizName" placeholder="e.g. Smile Dental Group" autocomplete="organization"/>
      </div>
      <div class="field">
        <label>Phone number</label>
        <input type="tel" id="detailsPhone" placeholder="(555) 123-4567" autocomplete="tel"/>
      </div>
      <div class="field">
        <label>Create a password</label>
        <input type="password" id="detailsPassword" placeholder="At least 8 characters" autocomplete="new-password"/>
      </div>
      <div class="err-msg" id="detailsErr"></div>
      <button class="modal-btn" onclick="submitSignupDetails()" id="detailsBtn">Request Trial →</button>
    </div>

    <!-- ── SUBMITTED panel (trial under review) ── -->
    <div id="pane-submitted" style="display:none;text-align:center;padding:8px 0;">
      <div style="width:52px;height:52px;border-radius:50%;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;">✓</div>
      <h2 style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">Welcome to co|op!</h2>
      <p class="modal-sub" style="margin-bottom:6px;line-height:1.55;">Your trial request is <strong style="color:#3ecf8e;">under review</strong>.</p>
      <p class="modal-sub" style="margin-bottom:20px;line-height:1.55;">We personally review every signup. You'll get an email the moment it's approved — with your dashboard key and a link to log in and access your logs.</p>
      <button class="modal-btn" onclick="closeModal()">Got it</button>
    </div>

    <!-- ── LICENSE KEY panel ── -->
    <div id="pane-key" style="display:none;">
      <button onclick="showPane('pane-main')" style="background:none;border:none;color:#475569;font-size:12px;cursor:pointer;margin-bottom:14px;padding:0;font-family:inherit;">← Back</button>
      <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px;">Enter your license key</h2>
      <p class="modal-sub" style="margin-bottom:16px;">Found in your welcome email — looks like <strong style="color:#fff;">SYP-XXXX-XXXX-XXXX</strong></p>
      <div class="field">
        <label>License Key</label>
        <input class="mono" id="keyInput" placeholder="SYP-XXXX-XXXX-XXXX" oninput="this.value=this.value.toUpperCase()" autocomplete="off"/>
        <div class="err-msg" id="keyErr"></div>
      </div>
      <button class="modal-btn" onclick="handleKey()" id="keyBtn">Open Dashboard →</button>
      <div style="text-align:center;margin-top:12px;font-size:11.5px;color:#475569;">
        No key? <a href="#" onclick="showPane('pane-main');return false;" style="color:#6366f1;text-decoration:none;">Sign in with email</a>
      </div>
    </div>

    <!-- ── FORGOT panel ── -->
    <div id="pane-forgot" style="display:none;">
      <button onclick="showPane('pane-main')" style="background:none;border:none;color:#475569;font-size:12px;cursor:pointer;margin-bottom:14px;padding:0;font-family:inherit;">← Back</button>
      <h2 style="font-size:1.1rem;font-weight:700;margin-bottom:4px;">Account recovery</h2>
      <p class="modal-sub" style="margin-bottom:16px;">We'll look up your account and resend your dashboard key to your email.</p>
      <div class="field">
        <label>Email you signed up with</label>
        <input type="email" id="recoveryEmail" placeholder="you@company.com" autocomplete="email"/>
        <div class="err-msg" id="recoveryErr"></div>
      </div>
      <button class="modal-btn" onclick="handleRecovery()" id="recoveryBtn">Send recovery email</button>
      <div id="recoverySuccess" style="display:none;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:7px;padding:11px 13px;margin-top:10px;font-size:12px;color:#3ecf8e;line-height:1.5;">
        ✓ If that email has an account, we've sent your dashboard key and a sign-in link.
      </div>
      <div style="text-align:center;margin-top:14px;font-size:11.5px;color:#475569;">
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
`;

(function mountAuthModal() {
  const mount = document.getElementById('authModalMount');
  if (mount && !document.getElementById('loginModal')) {
    mount.outerHTML = AUTH_MODAL_HTML;
  }
})();

const SESSION_KEY   = 'syphir_session';
const REMEMBER_KEY  = 'syphir_remember';
const SESSION_TTL   = 8 * 60 * 60 * 1000;   // 8 hours
const REMEMBER_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Session helpers ───────────────────────────────────────────────────────────
function saveSession(data, remember = false) {
  const payload = { ...data, authenticated_at: Date.now() };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload)); } catch(_) {}
  if (remember) {
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(payload)); } catch(_) {}
  }
}

function getSession() {
  // Check sessionStorage first
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (s?.key && Date.now() - s.authenticated_at < SESSION_TTL) return s;
  } catch(_) {}
  // Fall back to remembered session (30 days)
  try {
    const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
    if (r?.key && Date.now() - r.authenticated_at < REMEMBER_TTL) {
      // Restore into sessionStorage
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(r)); } catch(_) {}
      return r;
    }
  } catch(_) {}
  return null;
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch(_) {}
  try { localStorage.removeItem(REMEMBER_KEY); } catch(_) {}
}

// ── Nav state: profile icon (logged in) vs Dashboard Login (logged out) ──────
function initAuthCheck() {
  renderNavAuthState();
}

function renderNavAuthState() {
  const slot = document.getElementById('navAuthSlot');
  if (!slot) return;
  const session = getSession();

  if (session?.key) {
    const initial = (session.org_name || session.email || '?').trim().charAt(0).toUpperCase();
    slot.innerHTML = `
      <div class="profile-wrap">
        <button class="profile-btn" onclick="toggleProfileMenu(event)" aria-label="Account menu">${initial}</button>
        <div class="profile-dropdown" id="profileDropdown">
          ${session.email ? `<div class="profile-dropdown-email">${session.email}</div>` : ''}
          <a href="#" onclick="openDashboardChecked('${session.key}','${(session.org_name||'').replace(/'/g,"\\'")}');return false;">
            <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            Open Dashboard
          </a>
          <a href="billing.html?key=${encodeURIComponent(session.key)}">
            <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
            Manage Billing
          </a>
          <button class="danger" onclick="signOut()">
            <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
            Sign Out
          </button>
        </div>
      </div>
    `;
  } else {
    slot.innerHTML = `
      <button class="nav-btn" onclick="openModal()">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        Dashboard Login
      </button>
    `;
  }
}

function toggleProfileMenu(e) {
  e.stopPropagation();
  document.getElementById('profileDropdown')?.classList.toggle('open');
}

function signOut() {
  clearSession();
  renderNavAuthState();
  window.location.href = 'index.html';
}

document.addEventListener('click', () => {
  document.getElementById('profileDropdown')?.classList.remove('open');
});

// ── Panel navigation ──────────────────────────────────────────────────────────
function showPane(id) {
  ['pane-main','pane-details','pane-submitted','pane-key','pane-forgot','pane-set-password'].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.style.display = p === id ? '' : 'none';
  });
}

// ── Small helper: fetch with a timeout so a slow/cold-starting API doesn't
// just look like "nothing happened" — it fails fast with a clear message.
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

let _pendingSignupEmail = '';

// ── Step 1: check the email — the single entry point on pane-main ────────────
// Existing, approved accounts: logs straight into the dashboard.
// Existing, pending accounts: shows the "still under review" message.
// Unknown emails: moves to pane-details to collect business name + phone.
async function authContinue() {
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

    if (data.pending) {
      // Signup request already on file — no session, no dashboard access yet.
      if (succ) succ.style.display = '';
      try { localStorage.setItem('syphir_remembered_email', email); } catch(_) {}
      return;
    }

    // Existing, approved account — straight into the dashboard.
    try { localStorage.setItem('syphir_remembered_email', email); } catch(_) {}
    saveSession({ key: data.key, org_name: data.org_name, org_id: data.org_id, email }, true);
    goToDashboard(data.key, data.org_name);
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Continue →';
    console.error('co|op: authContinue failed:', e);
    if (e.name === 'AbortError') {
      showModalErr('Still connecting — our server may be waking up. Try again in a few seconds.', 'magicErr');
    } else {
      showModalErr('Could not connect. Try again in a moment.', 'magicErr');
    }
  }
}

// ── Step 2: submit business name + phone to actually create the trial request ─
async function submitSignupDetails() {
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

// ── License key login ─────────────────────────────────────────────────────────
function handleKey() {
  const raw = (document.getElementById('keyInput')?.value || '').trim().toUpperCase();
  const err = document.getElementById('keyErr');
  if (!raw) { if (err) err.textContent = 'Enter your license key.'; return; }
  if (raw.startsWith('EMP-')) {
    if (err) err.textContent = 'Employee keys only work in the Chrome extension. Ask your admin for the dashboard key.';
    return;
  }
  const btn = document.getElementById('keyBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  if (err) err.textContent = '';

  fetch(`${API}/validate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: raw, context: 'dashboard' }),
  })
  .then(r => r.json())
  .then(data => {
    btn.disabled = false;
    btn.textContent = 'Open Dashboard →';
    if (data.valid) {
      saveSession({ key: raw, org_name: data.org_name, org_id: data.org_id }, true);
      goToDashboard(raw, data.org_name);
    } else if (data.key_type === 'employee') {
      if (err) err.textContent = 'Employee keys only work in the Chrome extension.';
    } else if (data.expired) {
      if (err) err.textContent = 'Your trial has expired. Upgrade at co-optech.com/pricing.html';
    } else {
      if (err) err.textContent = 'Key not found. Check your welcome email or sign in with email.';
    }
  })
  .catch(() => {
    btn.disabled = false;
    btn.textContent = 'Open Dashboard →';
    if (err) err.textContent = 'Could not connect. Try again in a moment.';
  });
}

// ── Account recovery (forgot everything) ─────────────────────────────────────
async function handleRecovery() {
  const email = (document.getElementById('recoveryEmail')?.value || '').trim().toLowerCase();
  const err   = document.getElementById('recoveryErr');
  const btn   = document.getElementById('recoveryBtn');
  const succ  = document.getElementById('recoverySuccess');
  if (!email || !email.includes('@')) {
    if (err) err.textContent = 'Enter the email you used to sign up.';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (err) err.textContent = '';
  try {
    await fetch(`${API}/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    // Always show success (don't reveal if email exists)
    if (btn) { btn.disabled = false; btn.textContent = 'Send recovery email'; }
    if (succ) succ.style.display = '';
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send recovery email'; }
    if (err) err.textContent = 'Could not send recovery email. Try contacting support.';
  }
}

// ── Redirect to dashboard ─────────────────────────────────────────────────────
function goToDashboard(key, orgName) {
  closeModal();
  window.location.href = `app.html?key=${encodeURIComponent(key)}&org=${encodeURIComponent(orgName || '')}`;
}

// ── Shared trial-expired overlay ── shown when "Open Dashboard" is clicked with a
// cached session whose trial has actually expired. Same card app.html shows,
// but right here, without navigating away first. Uses its own internal
// names (startTrialCheckout / trial-checkout-msg) so it can never collide
// with app.html's separate copy of this same card.
function showTrialExpiredOverlay(key) {
  document.body.style.overflow = 'hidden';
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;background:rgba(0,0,0,0.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;padding:20px;z-index:9999;"><div style="background:#0a0a0a;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:48px 40px;max-width:480px;width:100%;text-align:center;"><div style="font-size:52px;margin-bottom:20px;">&#128274;</div><h1 style="font-size:22px;font-weight:800;color:#ffffff;margin:0 0 12px;">Your 7-day free trial has ended</h1><p style="font-size:14px;color:#8a8a8a;line-height:1.6;margin:0 0 28px;">Upgrade to keep your team's AI activity protected.</p><div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;"><button onclick="startTrialCheckout('Starter')" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);color:#ffffff;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;display:flex;justify-content:space-between;align-items:center;"><span>Starter</span><span style="color:#ffffff;font-weight:700;">$129/mo</span></button><button onclick="startTrialCheckout('Professional')" style="background:#ffffff;border:none;color:#000000;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:Inter,sans-serif;display:flex;justify-content:space-between;align-items:center;"><span>Professional Most Popular</span><span>$299/mo</span></button><button onclick="startTrialCheckout('Institution')" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);color:#ffffff;padding:13px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;display:flex;justify-content:space-between;align-items:center;"><span>Institution</span><span style="color:#ffffff;font-weight:700;">$599/mo</span></button></div><div id="trial-checkout-msg" style="font-size:12px;color:#8a8a8a;min-height:18px;margin-bottom:12px;"></div><a href="mailto:syphir26@gmail.com" style="display:block;font-size:12px;color:#555555;text-decoration:none;">Questions? Email syphir26@gmail.com</a></div></div>`);

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
      if (msg) { msg.style.color = '#f44336'; msg.textContent = 'Network error — try again'; }
    }
  };
}

// ── "Open Dashboard" from a cached session ── checks it's still valid FIRST instead
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
      // Key no longer valid at all (revoked, etc.) — safest is to sign out
      // and let them re-authenticate normally rather than guess further.
      clearSession();
      renderNavAuthState();
      openModal();
    }
  } catch(e) {
    // Network hiccup — fall back to normal navigation rather than blocking
    // them entirely; app.html's own check will still catch it from there.
    goToDashboard(key, orgName);
  }
}

// ── Modal open/close ──────────────────────────────────────────────────────────
function openModal() {
  // If already have a session, go straight to dashboard
  const session = getSession();
  if (session?.key) {
    goToDashboard(session.key, session.org_name);
    return;
  }
  showPane('pane-main');
  document.getElementById('loginModal')?.classList.add('active');
  document.body.style.overflow = 'hidden';
  // Pre-fill remembered email
  try {
    const remembered = localStorage.getItem('syphir_remembered_email');
    const field = document.getElementById('magicEmail');
    if (remembered && field) field.value = remembered;
  } catch(_) {}
  // Reset any stale state from a previous open
  const detailsBiz = document.getElementById('detailsBizName');
  if (detailsBiz) detailsBiz.value = '';
  const detailsPhone = document.getElementById('detailsPhone');
  if (detailsPhone) detailsPhone.value = '';
  const detailsErr = document.getElementById('detailsErr');
  if (detailsErr) detailsErr.textContent = '';
  setTimeout(() => document.getElementById('magicEmail')?.focus(), 100);
}

function closeModal() {
  const m = document.getElementById('loginModal');
  if (m) m.classList.remove('active');
  document.body.style.overflow = '';
}

window.addEventListener('click', e => {
  const m = document.getElementById('loginModal');
  if (m && e.target === m) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Error helper ──────────────────────────────────────────────────────────────
function showModalErr(msg, id) {
  const el = document.getElementById(id || 'magicErr');
  if (el) el.textContent = msg;
}

// ── Init ───────────────────────────────────────────────────────────────────────
initAuthCheck();

document.addEventListener('DOMContentLoaded', () => {
  renderNavAuthState();
  document.getElementById('magicEmail')?.addEventListener('keydown', e => {
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
  });
  document.getElementById('keyInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleKey();
  });
  document.getElementById('recoveryEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRecovery();
  });
});