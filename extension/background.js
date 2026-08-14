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

// ── HEARTBEAT ──────────────────────────────────────────────────────────────
// Lets the dashboard know Trace is still installed and running. Absence of
// heartbeats over time (not a real-time "uninstalled" signal — nothing can
// fire once the extension is actually gone) is how Settings shows an
// employee as Inactive and logs it as an incident.
async function sendHeartbeat() {
  chrome.storage.local.get(["syphir_key", "syphir_email"], async (data) => {
    if (!data.syphir_key || !data.syphir_email) return; // guest mode / not signed in — nothing to report
    try {
      await fetch(`${API}/extension/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: data.syphir_key, email: data.syphir_email }),
      });
    } catch (e) {} // non-fatal — offline or Render cold start, next heartbeat will catch up
  });
}

chrome.runtime.onInstalled.addListener(sendHeartbeat);
chrome.runtime.onStartup.addListener(sendHeartbeat);
chrome.alarms.create("syphir-heartbeat", { periodInMinutes: 20 });

// ── POLICIES ───────────────────────────────────────────────────────────────
// Pulls the org's whitelist (values Trace should never flag) and caches it
// locally so content.js can check matches instantly with no network call —
// detection stays fully client-side either way, this just keeps the
// whitelist current.
async function fetchPolicies() {
  chrome.storage.local.get(["syphir_key"], async (data) => {
    if (!data.syphir_key) return; // guest mode — no org to fetch policies for
    try {
      const res = await fetch(`${API}/policies?key=${encodeURIComponent(data.syphir_key)}`);
      const result = await res.json();
      chrome.storage.local.set({ syphir_whitelist: Array.isArray(result.whitelist) ? result.whitelist : [] });
    } catch (e) {} // non-fatal — keep using whatever was cached last
  });
}

chrome.runtime.onInstalled.addListener(fetchPolicies);
chrome.runtime.onStartup.addListener(fetchPolicies);
chrome.alarms.create("syphir-policies", { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "syphir-revalidate") validateKeyStatus();
  if (alarm.name === "syphir-heartbeat") sendHeartbeat();
  if (alarm.name === "syphir-policies") fetchPolicies();
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