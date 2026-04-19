const SYPHIR_API = "https://syphir-api.onrender.com";
let SYPHIR_KEY = "SYP-DEMO-2026-SYPHIR";
let USER_EMAIL = "employee@company.com";
let lastScanned = "";
let lastScannedTime = 0;

chrome.storage.local.get(["syphir_key", "syphir_email"], (data) => {
  if (data.syphir_key) SYPHIR_KEY = data.syphir_key;
  if (data.syphir_email) USER_EMAIL = data.syphir_email;
  console.log("Syphir Shield active on", window.location.hostname);
  wakeAPI();
});

function wakeAPI() {
  fetch(`${SYPHIR_API}/health`).catch(() => {});
}

// ── PII PATTERNS ─────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  // SSN — xxx-xx-xxxx or xxx xx xxxx
  { type: "SSN", regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, risk: "high" },

  // Credit card — flexible: any 13-19 digits with spaces/dashes, also catches "card number 123 4238 2323 394"
  { type: "CREDIT_CARD", regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})\b|\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{1,4}\b|\b\d{4}[\s\-]\d{6}[\s\-]\d{4,5}\b/g, risk: "high" },

  // Context-aware card: "credit card" / "card number" followed by digits
  { type: "CREDIT_CARD", regex: /(?:credit\s*card|card\s*(?:number|num|#|no))[^\d\n]{0,20}([\d][\d\s\-]{11,21}[\d])/gi, risk: "high" },

  // Context-aware SSN: "social security" / "ssn" followed by digits
  { type: "SSN", regex: /(?:social\s*security|ssn|s\.s\.n)[^\d\n]{0,20}(\d[\d\s\-]{6,12}\d)/gi, risk: "high" },

  // API keys
  { type: "API_KEY", regex: /\bsk-[A-Za-z0-9]{20,}\b|\bsk-ant-[A-Za-z0-9\-_]{20,}\b|\bBearer\s+[A-Za-z0-9\-_.~+\/]+=*\b/g, risk: "high" },
  { type: "API_KEY", regex: /(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token|private[_\-]?key)\s*[:=]\s*['""]?[A-Za-z0-9\-_]{16,}['""]?/gi, risk: "high" },

  // Medical record
  { type: "MEDICAL_RECORD", regex: /\b(?:MRN|medical\s*record\s*(?:number|num|#)?)\s*[:=]?\s*\d{4,10}\b/gi, risk: "high" },

  // Patient info context
  { type: "PATIENT_INFO", regex: /(?:patient|client|member)\s+(?:id|number|#|name)[^\n]{0,50}(?:\d{4,}|[A-Z][a-z]+\s+[A-Z][a-z]+)/g, risk: "high" },

  // Date of birth
  { type: "DATE_OF_BIRTH", regex: /\b(?:dob|date\s+of\s+birth|born\s+on|birthday)\s*[:\\/]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi, risk: "medium" },

  // Bank account / routing
  { type: "BANK_ACCOUNT", regex: /(?:account\s*(?:number|num|#)|routing\s*(?:number|num|#)|bank\s*(?:account|acct))[^\d\n]{0,15}\d{4,17}/gi, risk: "high" },

  // EIN / Tax ID
  { type: "EIN", regex: /\b(?:ein|tax\s*id|employer\s*id)[^\d\n]{0,10}\d{2}[-\s]?\d{7}\b|\b\d{2}-\d{7}\b/gi, risk: "medium" },

  // Passport
  { type: "PASSPORT", regex: /\b(?:passport\s*(?:number|num|#)?)\s*[:\-]?\s*[A-Z]\d{7,9}\b/gi, risk: "high" },

  // Driver's license context
  { type: "DRIVERS_LICENSE", regex: /(?:driver.{0,5}license|dl\s*(?:number|num|#))[^\n]{0,20}[A-Z0-9]{6,15}/gi, risk: "high" },

  // Email
  { type: "EMAIL", regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, risk: "low" },

  // Phone
  { type: "PHONE", regex: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, risk: "low" },

  // Insurance info
  { type: "INSURANCE_ID", regex: /(?:insurance\s*(?:id|number|policy|member)|policy\s*(?:number|num|#))[^\d\n]{0,15}\d{4,15}/gi, risk: "medium" },

  // Diagnosis / medical context
  { type: "MEDICAL_INFO", regex: /(?:diagnosis|prescribed|medication|treatment|condition|symptoms?)\s*[:=]?\s*[A-Za-z][\w\s,]{10,80}/gi, risk: "medium" },
];

function detectPII(text) {
  const findings = [];
  const seen = new Set();
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0;
    const matches = [...text.matchAll(p.regex)];
    for (const m of matches) {
      const raw = m[0];
      const key = p.type + raw.slice(0, 10);
      if (seen.has(key)) continue;
      seen.add(key);
      const masked = raw.length > 6 ? raw.slice(0,2) + "****" + raw.slice(-2) : "****";
      findings.push({ type: p.type, masked, risk: p.risk, label: p.type.replace(/_/g," ") });
    }
  }
  return findings;
}

function getRiskLevel(findings) {
  if (findings.some(f => f.risk === "high"))   return "high";
  if (findings.some(f => f.risk === "medium")) return "medium";
  return "low";
}

function buildMessage(findings) {
  const types = [...new Set(findings.map(f => f.label))];
  if (types.length === 1) return `${types[0]} detected — remove before sending`;
  if (types.length === 2) return `${types[0]} and ${types[1]} detected — remove before sending`;
  return `${types.slice(0,-1).join(", ")}, and ${types[types.length-1]} detected`;
}

// ── BANNER ───────────────────────────────────────────────────────────────────
function getAITool() {
  const h = window.location.hostname;
  if (h.includes("chatgpt") || h.includes("openai")) return "ChatGPT";
  if (h.includes("claude"))      return "Claude";
  if (h.includes("gemini") || h.includes("aistudio")) return "Gemini";
  if (h.includes("copilot"))     return "Copilot";
  if (h.includes("grok"))        return "Grok";
  if (h.includes("perplexity"))  return "Perplexity";
  if (h.includes("mistral"))     return "Mistral";
  if (h.includes("huggingface")) return "HuggingFace";
  if (h.includes("poe"))         return "Poe";
  if (h.includes("character"))   return "Character.AI";
  if (h.includes("you.com"))     return "You.com";
  if (h.includes("deepseek"))    return "DeepSeek";
  if (h.includes("groq"))        return "Groq";
  return "AI Tool";
}

function showBanner(message, risk) {
  const old = document.getElementById("syphir-banner");
  if (old) old.remove();
  const colors = {
    high:   { bg: "#ff4d6d", border: "#ff1a45" },
    medium: { bg: "#ff8c42", border: "#e67a30" },
    low:    { bg: "#ffd166", border: "#e6b800" },
  };
  const c = colors[risk] || colors.medium;
  if (!document.getElementById("syphir-style")) {
    const style = document.createElement("style");
    style.id = "syphir-style";
    style.textContent = `@keyframes syphirSlide{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}`;
    document.head.appendChild(style);
  }
  const d = document.createElement("div");
  d.id = "syphir-banner";
  d.style.cssText = `position:fixed;top:20px;right:20px;z-index:2147483647;background:${c.bg};border:1px solid ${c.border};border-radius:12px;padding:14px 16px;max-width:400px;min-width:280px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.35);animation:syphirSlide 0.3s ease;`;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = `background:rgba(255,255,255,0.25);border:none;color:#fff;padding:3px 8px;border-radius:5px;cursor:pointer;font-size:12px;float:right;margin-left:10px;font-family:inherit;`;
  closeBtn.addEventListener("click", () => d.remove());
  const content = document.createElement("div");
  content.style.cssText = `display:flex;align-items:flex-start;gap:10px;`;
  content.innerHTML = `<span style="font-size:20px;flex-shrink:0;">🛡️</span><div style="flex:1;"><div style="font-weight:700;font-size:13px;margin-bottom:3px;">Syphir — Sensitive Data Detected</div><div style="font-size:12px;opacity:0.92;line-height:1.4;">${message}</div></div>`;
  content.appendChild(closeBtn);
  d.appendChild(content);
  document.body.appendChild(d);
  setTimeout(() => { const b = document.getElementById("syphir-banner"); if (b) b.remove(); }, 8000);
}

// ── SCAN TEXT ────────────────────────────────────────────────────────────────
async function scan(text, source) {
  if (!text || text.trim().length < 5) return;
  const now = Date.now();
  if (text.trim() === lastScanned && now - lastScannedTime < 5000) return;
  lastScanned = text.trim();
  lastScannedTime = now;

  const findings = detectPII(text.trim());
  if (findings.length === 0) return;

  const risk_level = getRiskLevel(findings);
  const message    = buildMessage(findings);
  const ai_tool    = source || getAITool();

  showBanner(message, risk_level);

  try { chrome.runtime.sendMessage({ type: "INCIDENT_FLAGGED", risk_level }); } catch(e) {}

  // Re-read key from storage
  await new Promise(resolve => {
    chrome.storage.local.get(["syphir_key","syphir_email"], (data) => {
      if (data.syphir_key) SYPHIR_KEY = data.syphir_key;
      if (data.syphir_email) USER_EMAIL = data.syphir_email;
      resolve();
    });
  });

  const incident = {
    id: `inc_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
    key: SYPHIR_KEY,
    user_email: USER_EMAIL,
    ai_tool,
    url: window.location.href,
    risk_level,
    flagged: true,
    detections: findings.map(f => ({ label: f.label, type: f.type, masked: f.masked })),
    message,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(`${SYPHIR_API}/log-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(incident),
    });
  } catch (e) {
    setTimeout(async () => {
      try {
        await fetch(`${SYPHIR_API}/log-incident`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(incident),
        });
      } catch(e2) {}
    }, 3000);
  }
}

// ── FILE SCANNING ────────────────────────────────────────────────────────────
// Intercept file uploads and scan their text content
function scanFile(file) {
  if (!file) return;
  const textTypes = ["text/plain","text/csv","application/json","text/html","text/xml","application/xml","text/markdown"];
  const name = file.name.toLowerCase();
  const isText = textTypes.includes(file.type) || name.endsWith(".txt") || name.endsWith(".csv") || name.endsWith(".json") || name.endsWith(".md") || name.endsWith(".xml");

  if (isText) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      if (text) scan(text, getAITool() + " (file: " + file.name + ")");
    };
    reader.readAsText(file);
    return;
  }

  // For PDFs — warn immediately since we can't read them directly
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    showBanner(`PDF file uploaded: "${file.name}" — verify it contains no sensitive data`, "medium");
    return;
  }

  // For Word docs
  if (name.endsWith(".docx") || name.endsWith(".doc") || name.endsWith(".xlsx") || name.endsWith(".xls")) {
    showBanner(`Document uploaded: "${file.name}" — verify it contains no sensitive data`, "medium");
    return;
  }
}

// Watch for file input changes across the page
function watchFileInputs() {
  document.querySelectorAll('input[type="file"]').forEach(input => {
    if (input._syphirWatched) return;
    input._syphirWatched = true;
    input.addEventListener("change", (e) => {
      const files = e.target.files;
      if (files) Array.from(files).forEach(scanFile);
    });
  });
}

// Watch for drag-and-drop file uploads
document.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if (files) Array.from(files).forEach(scanFile);
}, true);

// Watch for paste events that might include file data
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  let text = "";
  for (const item of items) {
    if (item.kind === "string" && item.type === "text/plain") {
      item.getAsString(str => { if (str && str.length > 5) scan(str, getAITool() + " (paste)"); });
    }
    if (item.kind === "file") {
      scanFile(item.getAsFile());
    }
  }
}, true);

// ── INPUT DETECTION ─────────────────────────────────────────────────────────
function getText() {
  const selectors = [
    'div[contenteditable="true"]', "textarea", ".ProseMirror",
    '[role="textbox"]', '[class*="editor"]', '[class*="prompt"]',
    '[class*="message"]', '[class*="composer"]', '[class*="chat"]',
    '[class*="input"]',
  ];
  const active = document.activeElement;
  if (active && active !== document.body) {
    const t = active.value || active.innerText || active.textContent || "";
    if (t.trim().length > 5) return t.trim();
  }
  for (const s of selectors) {
    const els = document.querySelectorAll(s);
    for (const el of els) {
      const t = el.value || el.innerText || el.textContent || "";
      if (t.trim().length > 5) return t.trim();
    }
  }
  return "";
}

// Enter key
document.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    const t = getText();
    if (t) await scan(t);
  }
}, true);

// Send button clicks
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button, [role='button'], [type='submit']");
  if (!btn) return;
  const info = (btn.getAttribute("aria-label") || btn.getAttribute("data-testid") || btn.getAttribute("title") || btn.textContent || btn.className || "").toLowerCase();
  const isSend = info.includes("send") || info.includes("submit") || info.includes("ask") || btn.getAttribute("type") === "submit" || btn.closest("form");
  if (isSend) { const t = getText(); if (t) await scan(t); }
}, true);

// Form submits
document.addEventListener("submit", async (e) => {
  const t = getText(); if (t) await scan(t);
}, true);

// DOM mutations — catches React/Vue apps and new file inputs
new MutationObserver(async (mutations) => {
  let shouldWatchInputs = false;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      // Watch new file inputs
      if (node.querySelector && node.querySelector('input[type="file"]')) shouldWatchInputs = true;
      if (node.type === "file") shouldWatchInputs = true;
      // Scan new user messages
      const userSelectors = ['[data-message-author-role="user"]','[class*="human"]','[class*="user-turn"]','[class*="user-message"]','[class*="HumanMessage"]','[class*="UserMessage"]','[data-testid*="user"]','[class*="outgoing"]','[class*="sent"]'];
      for (const sel of userSelectors) {
        const found = node.matches?.(sel) ? node : node.querySelector?.(sel);
        if (found) {
          const t = found.innerText || found.textContent || "";
          if (t.trim().length > 10) await scan(t.trim());
        }
      }
    }
  }
  if (shouldWatchInputs) watchFileInputs();
}).observe(document.body, { childList: true, subtree: true });

// Initial file input watch
watchFileInputs();

console.log("Syphir Shield active on", getAITool(), "—", window.location.hostname);