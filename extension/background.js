let incidentCount = 0;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "INCIDENT_FLAGGED") {
    incidentCount++;

    // Update extension badge
    chrome.action.setBadgeText({ text: String(incidentCount) });
    chrome.action.setBadgeBackgroundColor({
      color: message.risk_level === "high" ? "#ff4444" : "#ff8800",
    });
  }

  if (message.type === "CLEAR_BADGE") {
    incidentCount = 0;
    chrome.action.setBadgeText({ text: "" });
  }
});