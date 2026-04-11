const API = "https://syphir-api.onrender.com";

chrome.storage.local.get(["syphir_key", "syphir_email", "syphir_org"], (data) => {
  if (data.syphir_key && data.syphir_org) {
    showActiveView(data.syphir_org, data.syphir_key);
  } else {
    showSetupView();
  }
});

function showSetupView() {
  document.getElementById("setupView").style.display = "block";
  document.getElementById("activeView").style.display = "none";
  document.getElementById("statusDot").style.background = "#ff4444";
  document.getElementById("statusDot").style.boxShadow = "0 0 6px #ff4444";
}

async function showActiveView(orgName, key) {
  document.getElementById("setupView").style.display = "none";
  document.getElementById("activeView").style.display = "block";
  document.getElementById("orgName").textContent = orgName;

  // Pull real stats from API
  try {
    // Get org_id from key
    const orgRes = await fetch(`${API}/org/${key}`);
    const org = await orgRes.json();

    if (org && org.id) {
      const statsRes = await fetch(`${API}/stats/${org.id}`);
      const stats = await statsRes.json();

      document.getElementById("totalScans").textContent = stats.total_incidents || 0;
      document.getElementById("highRisk").textContent   = stats.high_risk || 0;
      document.getElementById("medRisk").textContent    = stats.medium_risk || 0;
      document.getElementById("lowRisk").textContent    = stats.low_risk || 0;

      // Update badge to match real unresolved count
      const unresolved = stats.unresolved || 0;
      chrome.action.setBadgeText({ text: unresolved > 0 ? String(unresolved) : "" });
      chrome.action.setBadgeBackgroundColor({ color: "#ff4444" });
    }
  } catch (e) {
    console.log("Popup: Could not load stats", e.message);
  }
}

document.getElementById("activateBtn")?.addEventListener("click", async () => {
  const key   = document.getElementById("keyInput").value.trim();
  const email = document.getElementById("emailInput").value.trim();
  const msg   = document.getElementById("activateMsg");

  if (!key || !email) {
    msg.style.color = "#ff4444";
    msg.textContent = "Please enter both fields";
    return;
  }

  msg.style.color = "#8892a4";
  msg.textContent = "Validating...";

  try {
    const res  = await fetch(`${API}/validate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();

    if (data.valid) {
      chrome.storage.local.set({
        syphir_key:   key,
        syphir_email: email,
        syphir_org:   data.org_name,
      });
      msg.style.color = "#00e676";
      msg.textContent = "✓ Shield activated!";
      setTimeout(() => showActiveView(data.org_name, key), 800);
    } else {
      msg.style.color = "#ff4444";
      msg.textContent = "Invalid license key";
    }
  } catch {
    msg.style.color = "#ff4444";
    msg.textContent = "Cannot connect to Syphir API";
  }
});

document.getElementById("signOutBtn")?.addEventListener("click", () => {
  chrome.storage.local.clear();
  chrome.action.setBadgeText({ text: "" });
  showSetupView();
});

document.getElementById("dashboardBtn")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "file:///Users/bennygomez/Desktop/Syphir/dashboard/index.html" });
});