const API = "https://syphir-api.onrender.com";

// ── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Restore session or show login
  chrome.storage.local.get(["syphir_key", "syphir_org", "syphir_key_type"], (data) => {
    if (data.syphir_key && data.syphir_org) {
      showActive(data.syphir_org, data.syphir_key, data.syphir_key_type);
    } else {
      showLogin();
    }
  });

  // Tab switching
  document.getElementById("tabEmpBtn").addEventListener("click", () => switchTab("emp"));
  document.getElementById("tabAdmBtn").addEventListener("click", () => switchTab("adm"));

  // Auto-uppercase key inputs
  document.getElementById("empKey").addEventListener("input", function() { this.value = this.value.toUpperCase(); });
  document.getElementById("admKey").addEventListener("input", function() { this.value = this.value.toUpperCase(); });

  // Enter-key navigation
  document.getElementById("empKey").addEventListener("keydown",   e => { if (e.key === "Enter") document.getElementById("empEmail").focus(); });
  document.getElementById("empEmail").addEventListener("keydown", e => { if (e.key === "Enter") activateEmployee(); });
  document.getElementById("admKey").addEventListener("keydown",   e => { if (e.key === "Enter") document.getElementById("admEmail").focus(); });
  document.getElementById("admEmail").addEventListener("keydown", e => { if (e.key === "Enter") activateAdmin(); });

  // Activate buttons
  document.getElementById("empBtn").addEventListener("click", activateEmployee);
  document.getElementById("admBtn").addEventListener("click", activateAdmin);

  // Sign out
  document.getElementById("signOutBtn").addEventListener("click", () => {
    chrome.storage.local.clear();
    chrome.action.setBadgeText({ text: "" });
    showLogin();
  });

  // Hide Alerts toggle
  document.getElementById("alertToggleBtn").addEventListener("click", () => {
    chrome.storage.local.get(["syphir_hide_alerts"], (data) => {
      const next = !(data.syphir_hide_alerts === true);
      chrome.storage.local.set({ syphir_hide_alerts: next }, () => renderAlertToggle(next));
    });
  });

  // Footer site link
  document.getElementById("siteBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://syphir.vercel.app" });
  });
});

// ── VIEWS ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById("loginView").style.display  = "block";
  document.getElementById("activeView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-off";
  switchTab("emp");
}

async function showActive(orgName, key, keyType) {
  document.getElementById("loginView").style.display  = "none";
  document.getElementById("activeView").style.display = "block";
  document.getElementById("statusDot").className = "sdot sdot-on";

  document.getElementById("orgLabel").textContent = orgName;

  const pill = document.getElementById("keyPill");
  if (keyType === "employee") {
    pill.innerHTML = '<span class="pill pill-emp">Employee</span>';
  } else {
    pill.innerHTML = '<span class="pill pill-adm">Admin</span>';
  }

  // Restore alert toggle state
  chrome.storage.local.get(["syphir_hide_alerts"], (data) => {
    renderAlertToggle(data.syphir_hide_alerts === true);
  });

  // Load stats
  try {
    const orgRes = await fetch(`${API}/org/${key}`);
    const org    = await orgRes.json();
    if (org && org.id) {
      const statsRes = await fetch(`${API}/stats/${org.id}`);
      const s = await statsRes.json();
      document.getElementById("stTotal").textContent = s.total_incidents || 0;
      document.getElementById("stHigh").textContent  = s.high_risk       || 0;
      document.getElementById("stMed").textContent   = s.medium_risk     || 0;
      document.getElementById("stLow").textContent   = s.low_risk        || 0;
      const unresolved = s.unresolved || 0;
      chrome.action.setBadgeBackgroundColor({ color: "#ff4d6d" });
      chrome.action.setBadgeText({ text: unresolved > 0 ? (unresolved >= 9 ? "9+" : String(unresolved)) : "" });
    }
  } catch (e) {}
}

// ── TABS ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("tabEmpBtn").classList.toggle("active", tab === "emp");
  document.getElementById("tabAdmBtn").classList.toggle("active", tab === "adm");
  document.getElementById("paneEmp").classList.toggle("active",   tab === "emp");
  document.getElementById("paneAdm").classList.toggle("active",   tab === "adm");
}

// ── EMPLOYEE ACTIVATE ──────────────────────────────────────────────────────
async function activateEmployee() {
  const key   = document.getElementById("empKey").value.trim().toUpperCase();
  const email = document.getElementById("empEmail").value.trim();
  const msg   = document.getElementById("empMsg");
  const btn   = document.getElementById("empBtn");

  if (!key || !email)          { setMsg(msg, "red", "Please fill in both fields.");               return; }
  if (!key.startsWith("EMP-")) { setMsg(msg, "ora", "Employee keys start with EMP-. Check with your admin."); return; }
  if (!email.includes("@"))    { setMsg(msg, "red", "Enter a valid email address.");              return; }

  setMsg(msg, "gray", "Validating…");
  btn.disabled = true;

  try {
    const res  = await fetch(`${API}/validate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, context: "employee" }),
    });
    const data = await res.json();
    if (data.valid) {
      chrome.storage.local.set({
        syphir_key:      key,
        syphir_email:    email,
        syphir_org:      data.org_name,
        syphir_key_type: "employee",
      });
      setMsg(msg, "green", "✓ Shield activated!");
      setTimeout(() => showActive(data.org_name, key, "employee"), 600);
    } else {
      setMsg(msg, "red", data.message || "Invalid employee key. Check with your admin.");
      btn.disabled = false;
    }
  } catch (e) {
    setMsg(msg, "red", "Cannot connect to Syphir — try again.");
    btn.disabled = false;
  }
}

// ── ADMIN ACTIVATE ─────────────────────────────────────────────────────────
async function activateAdmin() {
  const key   = document.getElementById("admKey").value.trim().toUpperCase();
  const email = document.getElementById("admEmail").value.trim();
  const msg   = document.getElementById("admMsg");
  const btn   = document.getElementById("admBtn");

  if (!key || !email)       { setMsg(msg, "red", "Please fill in both fields.");  return; }
  if (!email.includes("@")) { setMsg(msg, "red", "Enter a valid email address."); return; }

  setMsg(msg, "gray", "Validating…");
  btn.disabled = true;

  try {
    const res  = await fetch(`${API}/validate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, context: "dashboard" }),
    });
    const data = await res.json();
    if (data.valid) {
      chrome.storage.local.set({
        syphir_key:      key,
        syphir_email:    email,
        syphir_org:      data.org_name,
        syphir_key_type: data.key_type || "business",
        syphir_role:     "admin",
      });
      setMsg(msg, "green", "✓ Shield activated!");
      setTimeout(() => showActive(data.org_name, key, data.key_type || "business"), 600);
    } else {
      setMsg(msg, "red", data.message || "Invalid key. Check your admin panel.");
      btn.disabled = false;
    }
  } catch (e) {
    setMsg(msg, "red", "Cannot connect to Syphir — try again.");
    btn.disabled = false;
  }
}

// ── ALERT TOGGLE ───────────────────────────────────────────────────────────
function renderAlertToggle(hidden) {
  const btn = document.getElementById("alertToggleBtn");
  if (!btn) return;
  if (hidden) {
    btn.textContent = "🔔 Show Alerts";
    btn.classList.add("alerts-hidden");
  } else {
    btn.textContent = "🔕 Hide Alerts";
    btn.classList.remove("alerts-hidden");
  }
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function setMsg(el, color, text) {
  const map = { red:"#ff4d6d", green:"#00d68f", gray:"#6868a0", ora:"#ffb347" };
  el.style.color = map[color] || color;
  el.textContent = text;
}
