let incidentCount = 0;

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

  if (count >= 9) {
    chrome.action.setBadgeText({ text: "9+" });
  } else {
    chrome.action.setBadgeText({ text: String(count) });
  }
}