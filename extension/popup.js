const API = "https://syphir-api.onrender.com";

// ── INIT ───────────────────────────────────────────────────────────────────
chrome.storage.local.get(["syphir_key", "syphir_email", "syphir_org", "syphir_key_type"], (data) => {
  if (data.syphir_key && data.syphir_org) {
    showActiveView(data.syphir_org, data.syphir_key, data.syphir_key_type);
  } else {
    showSetupView();
  }
});

// ── VIEWS ──────────────────────────────────────────────────────────────────
function showSetupView() {
  document.getElementById("setupView").style.display = "block";
  document.getElementById("activeView").style.display = "none";
  document.getElementById("statusDot").className = "status-dot dot-off";
}

async function showActiveView(orgName, key, keyType) {
  document.getElementById("setupView").style.display = "none";
  document.getElementById("activeView").style.display = "block";
  document.getElementById("statusDot").className = "status-dot dot-on";
  document.getElementById("orgName").textContent = orgName;

  const pill = document.getElementById("keyTypePill");
  if (keyType === "employee") {
    pill.innerHTML = '<span style="font-size:9px;font-weight:700;background:rgba(0,214,143,0.1);color:#00d68f;border:1px solid rgba(0,214,143,0.2);padding:2px 7px;border-radius:100px;text-transform:uppercase;letter-spacing:0.06em;">Employee</span>';
    document.getElementById("dashboardBtn").style.display = "none";
    document.getElementById("signOutBtn").style.display = "none";
  } else {
    pill.innerHTML = '<span style="font-size:9px;font-weight:700;background:rgba(91,79,232,0.12);color:#7b6df7;border:1px solid rgba(91,79,232,0.25);padding:2px 7px;border-radius:100px;text-transform:uppercase;letter-spacing:0.06em;">Business</span>';
    document.getElementById("dashboardBtn").style.display = "block";
    document.getElementById("signOutBtn").style.display = "block";
  }

  try {
    const orgRes = await fetch(`${API}/org/${key}`);
    const org = await orgRes.json();
    if (org && org.id) {
      const statsRes = await fetch(`${API}/stats/${org.id}`);
      const stats = await statsRes.json();
      document.getElementById("totalScans").textContent = stats.total_incidents || 0;
      document.getElementById("highRisk").textContent   = stats.high_risk || 0;
      document.getElementById("medRisk").textContent    = stats.medium_risk || 0;
      document.getElementById("lowRisk").textContent    = stats.low_risk || 0;
      setBadge(stats.unresolved || 0);
    }
  } catch (e) {
    console.log("Stats load failed:", e.message);
  }
}

// ── TABS ───────────────────────────────────────────────────────────────────
function switchSetupTab(tab) {
  document.getElementById("tabEmpBtn").classList.toggle("active", tab === "emp");
  document.getElementById("tabBizBtn").classList.toggle("active", tab === "biz");
  document.getElementById("tabEmp").classList.toggle("active", tab === "emp");
  document.getElementById("tabBiz").classList.toggle("active", tab === "biz");
}

// ── EMPLOYEE ACTIVATE ──────────────────────────────────────────────────────
async function activateEmployee() {
  const key   = document.getElementById("empKeyInput").value.trim().toUpperCase();
  const email = document.getElementById("empEmailInput").value.trim();
  const msg   = document.getElementById("empMsg");
  const btn   = document.getElementById("empActivateBtn");

  if (!key || !email) { setMsg(msg, "red", "Please fill in both fields."); return; }
  if (!key.startsWith("EMP-")) { setMsg(msg, "orange", "Employee keys start with EMP-. Check with your admin."); return; }

  setMsg(msg, "gray", "Validating…");
  btn.disabled = true;

  try {
    const res  = await fetch(`${API}/validate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, context: "extension" }),
    });
    const data = await res.json();
    if (data.valid) {
      chrome.storage.local.set({ syphir_key: key, syphir_email: email, syphir_org: data.org_name, syphir_key_type: "employee" });
      setMsg(msg, "green", "✓ Shield activated!");
      setTimeout(() => showActiveView(data.org_name, key, "employee"), 700);
    } else {
      btn.disabled = false;
      setMsg(msg, "red", data.message || "Invalid employee key. Check with your admin.");
    }
  } catch (e) {
    btn.disabled = false;
    setMsg(msg, "red", "Cannot connect to Syphir. Try again.");
  }
}

// ── BUSINESS ACTIVATE ──────────────────────────────────────────────────────
async function activateBusiness() {
  const key   = document.getElementById("bizKeyInput").value.trim().toUpperCase();
  const email = document.getElementById("bizEmailInput").value.trim();
  const msg   = document.getElementById("bizMsg");
  const btn   = document.getElementById("bizActivateBtn");

  if (!key || !email) { setMsg(msg, "red", "Please fill in both fields."); return; }

  setMsg(msg, "gray", "Validating…");
  btn.disabled = true;

  try {
    const res  = await fetch(`${API}/validate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, context: "extension" }),
    });
    const data = await res.json();
    if (data.valid) {
      chrome.storage.local.set({ syphir_key: key, syphir_email: email, syphir_org: data.org_name, syphir_key_type: data.key_type || "business" });
      setMsg(msg, "green", "✓ Shield activated!");
      setTimeout(() => showActiveView(data.org_name, key, data.key_type || "business"), 700);
    } else {
      btn.disabled = false;
      setMsg(msg, "red", data.message || "Invalid key. Check your admin panel.");
    }
  } catch (e) {
    btn.disabled = false;
    setMsg(msg, "red", "Cannot connect to Syphir. Try again.");
  }
}

// ── BADGE ──────────────────────────────────────────────────────────────────
function setBadge(count) {
  chrome.action.setBadgeBackgroundColor({ color: "#ff4d6d" });
  if (count <= 0) {
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeText({ text: count >= 9 ? "9+" : String(count) });
  }
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function setMsg(el, color, text) {
  const colors = { red:"#ff4d6d", green:"#00d68f", gray:"#7878a0", orange:"#ffb347" };
  el.style.color = colors[color] || color;
  el.textContent = text;
}

// ── ALL EVENT LISTENERS ────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

  // Tab switching
  document.getElementById("tabEmpBtn").addEventListener("click", () => switchSetupTab("emp"));
  document.getElementById("tabBizBtn").addEventListener("click", () => switchSetupTab("biz"));

  // Auto uppercase key inputs
  document.getElementById("empKeyInput").addEventListener("input", function() { this.value = this.value.toUpperCase(); });
  document.getElementById("bizKeyInput").addEventListener("input", function() { this.value = this.value.toUpperCase(); });

  // Activate buttons
  document.getElementById("empActivateBtn").addEventListener("click", activateEmployee);
  document.getElementById("bizActivateBtn").addEventListener("click", activateBusiness);

  // Enter key support
  document.getElementById("empKeyInput").addEventListener("keydown",   e => { if (e.key==="Enter") document.getElementById("empEmailInput").focus(); });
  document.getElementById("empEmailInput").addEventListener("keydown", e => { if (e.key==="Enter") activateEmployee(); });
  document.getElementById("bizKeyInput").addEventListener("keydown",   e => { if (e.key==="Enter") document.getElementById("bizEmailInput").focus(); });
  document.getElementById("bizEmailInput").addEventListener("keydown", e => { if (e.key==="Enter") activateBusiness(); });

  // Sign out
  document.getElementById("signOutBtn").addEventListener("click", () => {
    chrome.storage.local.clear();
    chrome.action.setBadgeText({ text: "" });
    showSetupView();
  });

  // Open dashboard
  document.getElementById("dashboardBtn").addEventListener("click", () => {
    chrome.storage.local.get(["syphir_key", "syphir_org"], (data) => {
      const url = data.syphir_key
        ? `https://syphir.vercel.app/app.html?key=${encodeURIComponent(data.syphir_key)}&org=${encodeURIComponent(data.syphir_org || "")}`
        : "https://syphir.vercel.app/app.html";
      chrome.tabs.create({ url });
    });
  });

  // Footer site link
  document.getElementById("siteLink").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://syphir.vercel.app" });
  });
});