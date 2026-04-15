// ── SYPHIR AUTH & BUSINESS REGISTRY ────────────────────────────────────────
const ADMIN_KEY = 'SYP-ADMIN-BENNY-2026';
const API = 'https://syphir-api.onrender.com';

const DEFAULT_BUSINESSES = [
  { id: 'biz_demo1', name: 'Demo Dental Practice', email: 'admin@dentalpractice.com', key: 'SYP-DEMO-2026-SYPHIR', emp_key: 'EMP-DENT-DEMO-2026', plan: 'Professional', status: 'demo', created: '2026-01-10' },
  { id: 'biz_ucr1',  name: 'UCR Medical School', email: 'sherif.hassan@medsch.ucr.edu', key: 'CS-PILOT-UCR1', emp_key: 'EMP-UCR-PILOT-01', plan: 'Starter', status: 'demo', created: '2026-02-01' },
  { id: 'biz_llu1',  name: 'Loma Linda University', email: 'lauraarellano@llu.edu', key: 'CS-PILOT-LLU1', emp_key: 'EMP-LLU-PILOT-01', plan: 'Starter', status: 'demo', created: '2026-02-15' },
];

function getBusinesses() {
  try {
    const stored = localStorage.getItem('syphir_businesses');
    if (stored) return JSON.parse(stored);
  } catch(e) {}
  saveBusinesses(DEFAULT_BUSINESSES);
  return DEFAULT_BUSINESSES;
}

function saveBusinesses(list) {
  localStorage.setItem('syphir_businesses', JSON.stringify(list));
}

function findBusinessByKey(key) {
  const k = key.toUpperCase();
  return getBusinesses().find(b =>
    b.key.toUpperCase() === k || (b.emp_key && b.emp_key.toUpperCase() === k)
  ) || null;
}

function isEmployeeKey(key) {
  const k = key.toUpperCase();
  const biz = getBusinesses().find(b => b.emp_key && b.emp_key.toUpperCase() === k);
  return !!biz;
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `SYP-${seg()}-${seg()}-${seg()}`;
}

function generateEmpKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `EMP-${seg()}-${seg()}`;
}

// ── MODAL ──────────────────────────────────────────────────────────────────
function openModal() {
  document.getElementById('loginModal').classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  const m = document.getElementById('loginModal');
  if (m) m.classList.remove('active');
  document.body.style.overflow = '';
  document.querySelectorAll('.err-msg').forEach(e => e.style.display = 'none');
}
window.addEventListener('click', e => {
  const m = document.getElementById('loginModal');
  if (m && e.target === m) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function switchTab(tab) {
  document.querySelectorAll('.modal-tab').forEach((t,i) => {
    t.classList.toggle('active', (i===0&&tab==='key')||(i===1&&tab==='email'));
  });
  const kp = document.getElementById('tab-key');
  const ep = document.getElementById('tab-email');
  if (kp) kp.classList.toggle('active', tab==='key');
  if (ep) ep.classList.toggle('active', tab==='email');
}

// ── KEY LOGIN ──────────────────────────────────────────────────────────────
function handleKey() {
  const raw = (document.getElementById('keyInput')?.value || '').trim().toUpperCase();
  const err = document.getElementById('keyErr');
  if (!raw) { showErr(err, 'Please enter your license key.'); return; }

  // Admin key
  if (raw === ADMIN_KEY) {
    hideErr(err);
    setBtnLoading('keyBtn', 'Opening admin panel…');
    setTimeout(() => { window.location.href = 'admin.html'; }, 600);
    return;
  }

  // Block employee keys from dashboard
  if (isEmployeeKey(raw)) {
    showErr(err, 'This is an employee key — it only works in the Syphir Chrome extension. Contact your admin for dashboard access.');
    return;
  }

  // Business key — check locally first
  const biz = findBusinessByKey(raw);
  if (biz && biz.key.toUpperCase() === raw) {
    hideErr(err);
    setBtnLoading('keyBtn', 'Opening your dashboard…');
    setTimeout(() => {
      window.location.href = 'app.html?key=' + encodeURIComponent(raw) + '&org=' + encodeURIComponent(biz.name);
    }, 600);
    return;
  }

  // Fall back to API validation
  setBtnLoading('keyBtn', 'Checking…');
  fetch(API + '/validate-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: raw, context: 'dashboard' }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.valid) {
      hideErr(err);
      window.location.href = 'app.html?key=' + encodeURIComponent(raw) + '&org=' + encodeURIComponent(data.org_name);
    } else if (data.key_type === 'employee') {
      resetBtn('keyBtn', 'Open Dashboard →');
      showErr(err, 'This is an employee key — it only works in the Chrome extension. Contact your admin for dashboard access.');
    } else {
      resetBtn('keyBtn', 'Open Dashboard →');
      showErr(err, 'Invalid key. Check your welcome email or contact support@syphir.io');
    }
  })
  .catch(() => {
    resetBtn('keyBtn', 'Open Dashboard →');
    showErr(err, 'Could not connect. Check your key or try again.');
  });
}

// ── EMAIL LOGIN ────────────────────────────────────────────────────────────
function handleEmail() {
  const email = (document.getElementById('emailIn')?.value || '').trim();
  const pass  = (document.getElementById('passIn')?.value  || '');
  const err   = document.getElementById('emailErr');
  if (!email || pass.length < 4) { showErr(err, 'Enter your email and password.'); return; }
  const biz = getBusinesses().find(b => b.email.toLowerCase() === email.toLowerCase());
  if (biz && pass.length >= 4) {
    hideErr(err);
    setBtnLoading('emailBtn', 'Signing in…');
    setTimeout(() => {
      window.location.href = 'app.html?key=' + encodeURIComponent(biz.key) + '&org=' + encodeURIComponent(biz.name);
    }, 600);
  } else {
    showErr(err, 'Invalid credentials. Try using your license key instead.');
  }
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function showErr(el, msg) { if (el) { el.textContent = msg; el.style.display = 'block'; } }
function hideErr(el) { if (el) el.style.display = 'none'; }
function setBtnLoading(id, text) {
  const btn = document.getElementById(id);
  if (btn) { btn.textContent = text; btn.disabled = true; }
}
function resetBtn(id, text) {
  const btn = document.getElementById(id);
  if (btn) { btn.textContent = text; btn.disabled = false; }
}
document.addEventListener('DOMContentLoaded', () => {
  const ki = document.getElementById('keyInput');
  if (ki) ki.addEventListener('keydown', e => { if (e.key==='Enter') handleKey(); });
  const ei = document.getElementById('emailIn');
  const pi = document.getElementById('passIn');
  if (ei) ei.addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('passIn')?.focus(); });
  if (pi) pi.addEventListener('keydown', e => { if (e.key==='Enter') handleEmail(); });
});