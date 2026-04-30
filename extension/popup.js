const API = "https://syphir-api.onrender.com";

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["syphir_key", "syphir_org", "syphir_key_type"], (data) => {
    if (data.syphir_key && data.syphir_org) {
      showActive(data.syphir_org, data.syphir_key);
    } else {
      showLogin();
    }
  });

  document.getElementById("empKey").addEventListener("input", function() { this.value = this.value.toUpperCase(); });
  document.getElementById("empKey").addEventListener("keydown",   e => { if (e.key === "Enter") document.getElementById("empEmail").focus(); });
  document.getElementById("empEmail").addEventListener("keydown", e => { if (e.key === "Enter") activate(); });
  document.getElementById("actBtn").addEventListener("click", activate);

  document.getElementById("signOutBtn").addEventListener("click", () => {
    chrome.storage.local.clear();
    chrome.action.setBadgeText({ text: "" });
    showLogin();
  });

  document.getElementById("alertToggleBtn").addEventListener("click", () => {
    chrome.storage.local.get(["syphir_hide_alerts"], (data) => {
      const next = !(data.syphir_hide_alerts === true);
      chrome.storage.local.set({ syphir_hide_alerts: next }, () => renderToggle(next));
    });
  });

  document.getElementById("siteBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://syphir.vercel.app" });
  });
});

function showLogin() {
  document.getElementById("loginView").style.display  = "block";
  document.getElementById("activeView").style.display = "none";
  document.getElementById("statusDot").className = "sdot sdot-off";
}

async function showActive(orgName, key) {
  document.getElementById("loginView").style.display  = "none";
  document.getElementById("activeView").style.display = "block";
  document.getElementById("statusDot").className = "sdot sdot-on";
  document.getElementById("orgLabel").textContent = orgName;

  chrome.storage.local.get(["syphir_hide_alerts"], (data) => {
    renderToggle(data.syphir_hide_alerts === true);
  });

  try {
    const orgRes = await fetch(`${API}/org/${key}`);
    const org    = await orgRes.json();
    if (org && org.id) {
      const s = await (await fetch(`${API}/stats/${org.id}`)).json();
      document.getElementById("stTotal").textContent = s.total_incidents || 0;
      document.getElementById("stHigh").textContent  = s.high_risk       || 0;
      document.getElementById("stMed").textContent   = s.medium_risk     || 0;
      document.getElementById("stLow").textContent   = s.low_risk        || 0;
      const u = s.unresolved || 0;
      chrome.action.setBadgeBackgroundColor({ color: "#ff4d6d" });
      chrome.action.setBadgeText({ text: u > 0 ? (u >= 9 ? "9+" : String(u)) : "" });
    }
  } catch (e) {}
}

async function activate() {
  const key   = document.getElementById("empKey").value.trim().toUpperCase();
  const email = document.getElementById("empEmail").value.trim();
  const msg   = document.getElementById("actMsg");
  const btn   = document.getElementById("actBtn");

  if (!key || !email)          { setMsg(msg, "red", "Please fill in both fields.");                        return; }
  if (!key.startsWith("EMP-")) { setMsg(msg, "ora", "Employee keys start with EMP- — check with your admin."); return; }
  if (!email.includes("@"))    { setMsg(msg, "red", "Enter a valid email address.");                       return; }

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
      setTimeout(() => showActive(data.org_name, key), 600);
    } else {
      setMsg(msg, "red", data.message || "Invalid key — check with your admin.");
      btn.disabled = false;
    }
  } catch (e) {
    setMsg(msg, "red", "Cannot connect to Syphir — try again.");
    btn.disabled = false;
  }
}

function renderToggle(hidden) {
  const btn = document.getElementById("alertToggleBtn");
  if (!btn) return;
  btn.textContent = hidden ? "🔔 Show Alerts" : "🔕 Hide Alerts";
  btn.classList.toggle("alerts-hidden", hidden);
}

function setMsg(el, color, text) {
  const map = { red: "#ff4d6d", green: "#00d68f", gray: "#6868a0", ora: "#ffb347" };
  el.style.color = map[color] || color;
  el.textContent = text;
}
