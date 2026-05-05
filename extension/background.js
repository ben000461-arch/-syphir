const API = "https://syphir-api.onrender.com";
let incidentCount = 0;

// ── KEY REVALIDATION ───────────────────────────────────────────────────────
async function validateKeyStatus() {
  chrome.storage.local.get(["syphir_key"], async (data) => {
    if (!data.syphir_key) return;
    try {
      const res = await fetch(`${API}/validate-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: data.syphir_key, context: "employee" }),
      });
      const result = await res.json();
      if (!result.valid && result.expired) {
        chrome.storage.local.set({ syphir_expired: true });
      } else if (result.valid) {
        // Clear expired flag if admin renewed the plan
        chrome.storage.local.remove("syphir_expired");
      }
    } catch(e) {} // non-fatal — offline or Render cold start
  });
}

// Validate on install and browser startup
chrome.runtime.onInstalled.addListener(validateKeyStatus);
chrome.runtime.onStartup.addListener(validateKeyStatus);

// Re-validate every 6 hours to catch renewals and expiry
chrome.alarms.create("syphir-revalidate", { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "syphir-revalidate") validateKeyStatus();
});

// ── BADGE ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "INCIDENT_FLAGGED") {
    incidentCount++;
    updateBadge(incidentCount, message.risk_level);
  }
  if (message.type === "CLEAR_BADGE") {
    incidentCount = 0;
    chrome.action.setBadgeText({ text: "" });
  }
});

function updateBadge(count, riskLevel) {
  const color = riskLevel === "high" ? "#ff4444" : "#ff8800";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text: count >= 9 ? "9+" : String(count) });
}
