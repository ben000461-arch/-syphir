// ── SYPHIR AUTH ───────────────────────────────────────────────────────────────
const API = 'https://syphir-api.onrender.com';
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
          <a href="#" onclick="goToDashboard('${session.key}','${(session.org_name||'').replace(/'/g,"\\'")}');return false;">
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
  ['pane-main','pane-details','pane-key','pane-forgot'].forEach(p => {
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
    console.error('Syphir: authContinue failed:', e);
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
  const err     = document.getElementById('detailsErr');
  const succ    = document.getElementById('detailsSuccess');
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
    const data = await r.json();
    btn.disabled = false;
    btn.textContent = 'Request Trial →';

    if (!r.ok || data.error) {
      if (err) err.textContent = data.error || 'Could not connect. Try again in a moment.';
      return;
    }

    if (succ) succ.style.display = '';
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Request Trial →';
    console.error('Syphir: submitSignupDetails failed:', e);
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
      if (err) err.textContent = 'Your trial has expired. Upgrade at syphir.vercel.app/pricing.html';
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
  const detailsSucc = document.getElementById('detailsSuccess');
  if (detailsSucc) detailsSucc.style.display = 'none';
  const detailsBiz = document.getElementById('detailsBizName');
  if (detailsBiz) detailsBiz.value = '';
  const detailsPhone = document.getElementById('detailsPhone');
  if (detailsPhone) detailsPhone.value = '';
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
  document.getElementById('detailsBizName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });
  document.getElementById('detailsPhone')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSignupDetails();
  });
  document.getElementById('keyInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleKey();
  });
  document.getElementById('recoveryEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRecovery();
  });
});