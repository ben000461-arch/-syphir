// ── SYPHIR AUTH ───────────────────────────────────────────────────────────────
const API = 'https://syphir-api.onrender.com';
const SUPABASE_URL  = 'https://pfrojobhrmfnoxavlrmm.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmcm9qb2Jocm1mbm94YXZscm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MTU5MDcsImV4cCI6MjA5MTQ5MTkwN30.0FFbJq_gwsFtZSQY7isojouZAlt3xWAUBGFXx-j9nbzo';
const SESSION_KEY   = 'syphir_session';
const REMEMBER_KEY  = 'syphir_remember';
const SESSION_TTL   = 8 * 60 * 60 * 1000;   // 8 hours
const REMEMBER_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days

let sb = null;
function getSB() {
  if (!sb && window.supabase) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  return sb;
}

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

// ── Auto-redirect if already logged in ───────────────────────────────────────
(function checkAutoLogin() {
  // Check saved session
  const session = getSession();
  if (session?.key) {
    // Show "returning user" state on the button
    const btn = document.querySelector('.nav-btn[onclick*="openModal"]');
    if (btn) {
      btn.textContent = '→ Open Dashboard';
      btn.onclick = () => goToDashboard(session.key, session.org_name);
    }
    return;
  }

  // Check Supabase OAuth callback (Google redirect)
  if (window.location.hash.includes('access_token') || window.location.search.includes('code=')) {
    handleSupabaseCallback();
  }
})();

async function handleSupabaseCallback() {
  const client = getSB();
  if (!client) return;
  const { data: { session } } = await client.auth.getSession();
  if (session?.user) {
    await provisionAndRedirect(session.user, true);
  }
}

// ── Panel navigation ──────────────────────────────────────────────────────────
function showPane(id) {
  ['pane-main','pane-key','pane-forgot'].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.style.display = p === id ? '' : 'none';
  });
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
async function authGoogle() {
  const client = getSB();
  if (!client) { showModalErr('Google auth not available — use email or key.'); return; }
  const btn = document.getElementById('googleBtn');
  if (btn) { btn.style.opacity = '0.6'; btn.style.pointerEvents = 'none'; }
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/index.html',
    }
  });
  if (error) {
    if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = ''; }
    showModalErr(error.message);
  }
  // Page will redirect — no need to reset button
}

// ── Email sign-in (direct, no magic-link wait) ───────────────────────────────
async function authMagicLink() {
  const emailField = document.getElementById('magicEmail');
  const email = (emailField?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    showModalErr('Enter a valid business email.', 'magicErr');
    return;
  }
  const btn = document.getElementById('magicBtn');
  const err = document.getElementById('magicErr');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  if (err) err.textContent = '';

  try {
    // Direct provision — no Supabase auth token required for email-only flow
    const r = await fetch(`${API}/auth/provision-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await r.json();
    btn.disabled = false;
    btn.textContent = 'Sign in →';

    if (data.key) {
      // Remember this email for next visit
      try { localStorage.setItem('syphir_remembered_email', email); } catch(_) {}
      saveSession({ key: data.key, org_name: data.org_name, org_id: data.org_id, email }, true);
      goToDashboard(data.key, data.org_name);
    } else {
      if (err) err.textContent = data.error || 'Could not sign in. Try your license key instead.';
    }
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Sign in →';
    if (err) err.textContent = 'Could not connect. Try again in a moment.';
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
      if (err) err.textContent = 'Key not found. Check your welcome email or use email sign-in.';
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
  await handleRecoveryFor(email, btn, succ, err, 'Send recovery email');
}

async function handleRecoveryFor(email, btn, succ, err, resetLabel) {
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (err) err.textContent = '';
  try {
    const r = await fetch(`${API}/auth/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    // Always show success (don't reveal if email exists)
    if (btn) { btn.disabled = false; btn.textContent = resetLabel; }
    if (succ) succ.style.display = '';
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = resetLabel; }
    if (err) err.textContent = 'Could not send recovery email. Try contacting support.';
  }
}

// ── Provision after Supabase OAuth ───────────────────────────────────────────
async function provisionAndRedirect(user, remember = true) {
  try {
    const client = getSB();
    const { data: { session } } = await client.auth.getSession();
    const token = session?.access_token;
    const r = await fetch(`${API}/auth/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        email:    user.email,
        name:     user.user_metadata?.full_name || user.email.split('@')[0],
        provider: user.app_metadata?.provider || 'email',
      }),
    });
    const data = await r.json();
    if (data.key) {
      saveSession({ key: data.key, org_name: data.org_name, org_id: data.org_id, email: user.email }, remember);
      goToDashboard(data.key, data.org_name);
    } else {
      showModalErr(data.error || 'Could not provision account. Contact support.');
    }
  } catch(e) {
    showModalErr('Authentication error. Please try again.');
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
  document.getElementById('loginModal').classList.add('active');
  document.body.style.overflow = 'hidden';
  // Pre-fill remembered email
  try {
    const remembered = localStorage.getItem('syphir_remembered_email');
    const field = document.getElementById('magicEmail');
    if (remembered && field) field.value = remembered;
  } catch(_) {}
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

// ── Enter key support ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('magicEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') authMagicLink();
  });
  document.getElementById('keyInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleKey();
  });
  document.getElementById('recoveryEmail')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleRecovery();
  });

  // Check Supabase OAuth callback
  if (window.location.hash.includes('access_token') || window.location.search.includes('code=')) {
    const client = getSB();
    if (client) {
      client.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) provisionAndRedirect(session.user, true);
      });
    }
  }
});

// Legacy stubs so old inline callers don't break
function switchTab() {}
function handleEmail() { authMagicLink(); }