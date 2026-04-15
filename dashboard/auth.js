// ── SYPHIR AUTH & BUSINESS REGISTRY ────────────────────────────────────────
// Admin key — only Benny
const ADMIN_KEY = 'SYP-ADMIN-BENNY-2026';

// Built-in demo businesses (always valid even if localStorage is empty)
const DEFAULT_BUSINESSES = [
  { id: 'biz_demo1', name: 'Demo Dental Practice', email: 'admin@dentalpractice.com', key: 'SYP-DEMO-2026-SYPHIR', plan: 'Professional', status: 'demo', created: '2026-01-10' },
  { id: 'biz_ucr1',  name: 'UCR Medical School',   email: 'sherif.hassan@medsch.ucr.edu', key: 'CS-PILOT-UCR1', plan: 'Starter', status: 'demo', created: '2026-02-01' },
  { id: 'biz_llu1',  name: 'Loma Linda University', email: 'lauraarellano@llu.edu', key: 'CS-PILOT-LLU1', plan: 'Starter', status: 'demo', created: '2026-02-15' },
];

function getBusinesses() {
  try {
    const stored = localStorage.getItem('syphir_businesses');
    if (stored) return JSON.parse(stored);
  } catch(e) {}
  // First load — seed defaults
  saveBusinesses(DEFAULT_BUSINESSES);
  return DEFAULT_BUSINESSES;
}

function saveBusinesses(list) {
  localStorage.setItem('syphir_businesses', JSON.stringify(list));
}

function findBusinessByKey(key) {
  const bizList = getBusinesses();
  return bizList.find(b => b.key.toUpperCase() === key.toUpperCase()) || null;
}

function generateKey(bizName) {
  // Format: SYP-XXXX-XXXX-XXXX based on name + timestamp
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `SYP-${seg()}-${seg()}-${seg()}`;
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
  const errs = document.querySelectorAll('.err-msg');
  errs.forEach(e => e.style.display = 'none');
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
  const keyPane = document.getElementById('tab-key');
  const emailPane = document.getElementById('tab-email');
  if (keyPane) keyPane.classList.toggle('active', tab==='key');
  if (emailPane) emailPane.classList.toggle('active', tab==='email');
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

  // Business key
  const biz = findBusinessByKey(raw);
  if (biz) {
    hideErr(err);
    setBtnLoading('keyBtn', 'Opening your dashboard…');
    setTimeout(() => {
      window.location.href = 'app.html?key=' + encodeURIComponent(raw) + '&org=' + encodeURIComponent(biz.name);
    }, 600);
    return;
  }

  showErr(err, 'Invalid key. Check your welcome email or contact support@syphir.io');
}

// ── EMAIL LOGIN ────────────────────────────────────────────────────────────
function handleEmail() {
  const email = (document.getElementById('emailIn')?.value || '').trim();
  const pass  = (document.getElementById('passIn')?.value  || '');
  const err   = document.getElementById('emailErr');
  if (!email || pass.length < 4) { showErr(err, 'Enter your email and password.'); return; }
  // Check if email matches any business
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

// Allow Enter key to submit
document.addEventListener('DOMContentLoaded', () => {
  const ki = document.getElementById('keyInput');
  if (ki) ki.addEventListener('keydown', e => { if (e.key==='Enter') handleKey(); });
  const ei = document.getElementById('emailIn');
  const pi = document.getElementById('passIn');
  if (ei) ei.addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('passIn')?.focus(); });
  if (pi) pi.addEventListener('keydown', e => { if (e.key==='Enter') handleEmail(); });
});
