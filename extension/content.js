const SYPHIR_API = "https://syphir-api.onrender.com";
let SYPHIR_KEY = "SYP-DEMO-2026-SYPHIR";
let USER_EMAIL = "employee@company.com";
let lastScanned = "";
let lastScannedTime = 0;
let scannedFiles = new Set();

chrome.storage.local.get(["syphir_key", "syphir_email"], (data) => {
  if (data.syphir_key) SYPHIR_KEY = data.syphir_key;
  if (data.syphir_email) USER_EMAIL = data.syphir_email;
  wakeAPI();
});

function wakeAPI() {
  fetch(`${SYPHIR_API}/health`).catch(() => {});
}

// ── PII PATTERNS ──────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  // SSN
  { type: "SSN", regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, risk: "high" },
  { type: "SSN", regex: /(?:social\s*security|ssn|s\.s\.n\.?)\D{0,20}(\d[\d\s\-]{6,12}\d)/gi, risk: "high" },

  // Credit card — real formats
  { type: "CREDIT_CARD", regex: /\b4\d{12}(?:\d{3})?\b|\b5[1-5]\d{14}\b|\b3[47]\d{13}\b|\b6(?:011|5\d{2})\d{12}\b/g, risk: "high" },
  // Credit card — spaced/dashed formats
  { type: "CREDIT_CARD", regex: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{1,4}\b/g, risk: "high" },
  // Credit card — CONTEXT AWARE (catches any digits near "card" keyword)
  { type: "CREDIT_CARD", regex: /(?:credit\s*card|card\s*(?:number|num|no\.?|#))[^a-zA-Z\n]{0,30}(\d[\d\s\-\.]{10,25}\d)/gi, risk: "high" },

  // API keys
  { type: "API_KEY", regex: /\bsk-[A-Za-z0-9]{20,}\b|\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g, risk: "high" },
  { type: "API_KEY", regex: /\bBearer\s+[A-Za-z0-9\-_.~+\/]{20,}=*\b/g, risk: "high" },
  { type: "API_KEY", regex: /(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token)\s*[:=]\s*["']?[A-Za-z0-9\-_]{16,}["']?/gi, risk: "high" },

  // Medical record
  { type: "MEDICAL_RECORD", regex: /\bMRN[-:\s]*\d{4,10}\b/gi, risk: "high" },
  { type: "MEDICAL_RECORD", regex: /medical\s*record\s*(?:number|num|#)?\s*[:=\-]?\s*\d{4,10}/gi, risk: "high" },

  // Date of birth
  { type: "DATE_OF_BIRTH", regex: /(?:dob|date\s+of\s+birth|born\s+on)\s*[:\-\/]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/gi, risk: "medium" },

  // Bank / routing
  { type: "BANK_ACCOUNT", regex: /(?:routing\s*(?:number|num|#)?)\s*[:=\-]?\s*\d{9}/gi, risk: "high" },
  { type: "BANK_ACCOUNT", regex: /(?:account\s*(?:number|num|#))\s*[:=\-]?\s*\d{6,17}/gi, risk: "high" },

  // EIN
  { type: "EIN", regex: /\b\d{2}-\d{7}\b/g, risk: "medium" },

  // Passport
  { type: "PASSPORT", regex: /(?:passport)\s*(?:number|num|#)?\s*[:=\-]?\s*[A-Z]{1,2}\d{6,9}/gi, risk: "high" },

  // Driver license
  { type: "DRIVERS_LICENSE", regex: /(?:driver.{0,5}licen[sc]e|dl\s*(?:number|num|#))\s*[:=\-]?\s*[A-Z0-9]{6,15}/gi, risk: "high" },

  // Insurance
  { type: "INSURANCE_ID", regex: /(?:policy\s*(?:number|num|#)|member\s*id|insurance\s*(?:id|number))\s*[:=\-]?\s*[A-Z0-9\-]{4,20}/gi, risk: "medium" },

  // Email
  { type: "EMAIL", regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, risk: "low" },

  // Phone
  { type: "PHONE", regex: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, risk: "low" },

  // Generic sensitive number context
  { type: "SENSITIVE_ID", regex: /(?:patient\s*id|client\s*id|member\s*number|employee\s*id)\s*[:=\-]?\s*\d{4,}/gi, risk: "medium" },

  // Medical info context
  { type: "MEDICAL_INFO", regex: /(?:diagnosis|prescribed|medication|treatment plan)\s*[:=]?\s*[A-Za-z][\w\s,]{10,60}/gi, risk: "medium" },
];

function detectPII(text) {
  const findings = [];
  const seen = new Set();
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0;
    try {
      const matches = [...text.matchAll(p.regex)];
      for (const m of matches) {
        const raw = m[0];
        const key = p.type + "|" + raw.replace(/\s/g,"").slice(0,12);
        if (seen.has(key)) continue;
        seen.add(key);
        const masked = raw.length > 6 ? raw.slice(0,2) + "****" + raw.slice(-2) : "****";
        findings.push({ type: p.type, masked, risk: p.risk, label: p.type.replace(/_/g," ") });
      }
    } catch(e) {}
  }
  return findings;
}

function getRiskLevel(f) {
  if (f.some(x => x.risk === "high"))   return "high";
  if (f.some(x => x.risk === "medium")) return "medium";
  return "low";
}

function buildMessage(findings) {
  const types = [...new Set(findings.map(f => f.label))];
  if (types.length === 1) return `${types[0]} detected — remove before sending`;
  if (types.length === 2) return `${types[0]} and ${types[1]} detected`;
  return `${types.slice(0,-1).join(", ")}, and ${types[types.length-1]} detected`;
}

// ── BANNER ────────────────────────────────────────────────────────────────────
function getAITool() {
  const h = window.location.hostname;
  if (h.includes("chatgpt") || h.includes("openai")) return "ChatGPT";
  if (h.includes("claude") || h.includes("anthropic")) return "Claude";
  if (h.includes("gemini") || h.includes("aistudio")) return "Gemini";
  if (h.includes("copilot") || h.includes("bing")) return "Copilot";
  if (h.includes("grok"))        return "Grok";
  if (h.includes("perplexity"))  return "Perplexity";
  if (h.includes("mistral"))     return "Mistral";
  if (h.includes("deepseek"))    return "DeepSeek";
  if (h.includes("groq"))        return "Groq";
  if (h.includes("cohere") || h.includes("coral")) return "Cohere";
  if (h.includes("poe"))         return "Poe";
  if (h.includes("huggingface")) return "HuggingFace";
  if (h.includes("meta.ai") || h.includes("llama")) return "Meta AI";
  if (h.includes("pi.ai"))       return "Pi";
  if (h.includes("venice"))      return "Venice AI";
  if (h.includes("openrouter"))  return "OpenRouter";
  if (h.includes("notion"))      return "Notion AI";
  if (h.includes("jasper"))      return "Jasper";
  if (h.includes("writesonic"))  return "Writesonic";
  if (h.includes("character"))   return "Character.AI";
  if (h.includes("you.com"))     return "You.com";
  if (h.includes("phind"))       return "Phind";
  if (h.includes("lmsys") || h.includes("arena")) return "LMSYS Arena";
  return "AI Tool";
}

function showBanner(message, risk) {
  const old = document.getElementById("syphir-banner");
  if (old) old.remove();
  const colors = { high:{ bg:"#ff4d6d",border:"#ff1a45" }, medium:{ bg:"#ff8c42",border:"#e67a30" }, low:{ bg:"#ffd166",border:"#e6b800" } };
  const c = colors[risk] || colors.medium;
  if (!document.getElementById("syphir-style")) {
    const s = document.createElement("style");
    s.id = "syphir-style";
    s.textContent = `@keyframes syphirSlide{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}`;
    document.head.appendChild(s);
  }
  const d = document.createElement("div");
  d.id = "syphir-banner";
  d.style.cssText = `position:fixed;top:20px;right:20px;z-index:2147483647;background:${c.bg};border:1px solid ${c.border};border-radius:12px;padding:14px 16px;max-width:420px;min-width:280px;color:#fff;font-family:-apple-system,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.4);animation:syphirSlide 0.3s ease;`;
  const x = document.createElement("button");
  x.textContent = "✕";
  x.style.cssText = `background:rgba(255,255,255,0.25);border:none;color:#fff;padding:3px 8px;border-radius:5px;cursor:pointer;font-size:12px;float:right;margin-left:10px;`;
  x.addEventListener("click", () => d.remove());
  const body = document.createElement("div");
  body.style.cssText = `display:flex;align-items:flex-start;gap:10px;`;
  body.innerHTML = `<span style="font-size:20px;flex-shrink:0;">🛡️</span><div style="flex:1;"><div style="font-weight:700;font-size:13px;margin-bottom:3px;">Syphir — Sensitive Data Detected</div><div style="font-size:12px;opacity:0.92;line-height:1.4;">${message}</div></div>`;
  body.appendChild(x);
  d.appendChild(body);
  document.body.appendChild(d);
  setTimeout(() => { const b = document.getElementById("syphir-banner"); if (b) b.remove(); }, 8000);
}

// ── LOG INCIDENT ──────────────────────────────────────────────────────────────
async function logIncident(findings, risk_level, message, ai_tool) {
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
    ai_tool: ai_tool || getAITool(),
    url: window.location.href,
    risk_level,
    flagged: true,
    detections: findings.map(f => ({ label: f.label, type: f.type, masked: f.masked })),
    message,
    timestamp: new Date().toISOString(),
  };
  const send = () => fetch(`${SYPHIR_API}/log-incident`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(incident),
  });
  try { await send(); } catch(e) {
    setTimeout(() => send().catch(()=>{}), 3000);
  }
}

// ── SCAN TEXT ─────────────────────────────────────────────────────────────────
async function scan(text, source) {
  if (!text || text.trim().length < 5) return;
  const now = Date.now();
  const trimmed = text.trim();
  if (trimmed === lastScanned && now - lastScannedTime < 5000) return;
  lastScanned = trimmed;
  lastScannedTime = now;

  const findings = detectPII(trimmed);
  if (!findings.length) return;

  const risk_level = getRiskLevel(findings);
  const message    = buildMessage(findings);
  const tool       = source || getAITool();

  showBanner(message, risk_level);
  try { chrome.runtime.sendMessage({ type: "INCIDENT_FLAGGED", risk_level }); } catch(e) {}
  await logIncident(findings, risk_level, message, tool);
}

// ── FILE SCANNING ─────────────────────────────────────────────────────────────
function readAndScanFile(file) {
  if (!file || scannedFiles.has(file.name + file.size)) return;
  scannedFiles.add(file.name + file.size);

  const name = file.name.toLowerCase();
  const textExts = [".txt",".csv",".json",".md",".xml",".log",".sql",".yaml",".yml",".env",".ini",".cfg"];
  const isText = textExts.some(e => name.endsWith(e)) ||
    (file.type && (file.type.startsWith("text/") || file.type === "application/json"));

  if (isText) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      if (text) await scan(text, getAITool() + ` (file: ${file.name})`);
    };
    reader.readAsText(file);
    return;
  }

  // For docs/PDFs we can't read content but warn based on filename
  const sensitiveNames = /patient|medical|health|billing|ssn|invoice|record|confidential|private|hipaa|phi|personal|insurance|payroll|employee|account/i;
  if (sensitiveNames.test(name)) {
    showBanner(`Sensitive file detected: "${file.name}" — verify it contains no PHI or PII`, "medium");
    return;
  }

  if (name.endsWith(".pdf") || name.endsWith(".docx") || name.endsWith(".doc") || name.endsWith(".xlsx")) {
    showBanner(`Document uploaded: "${file.name}" — ensure it contains no sensitive data`, "low");
  }
}

// Intercept ALL file input changes
function watchFileInputs() {
  document.querySelectorAll('input[type="file"]').forEach(input => {
    if (input._syphir) return;
    input._syphir = true;
    input.addEventListener("change", (e) => {
      if (e.target.files) Array.from(e.target.files).forEach(readAndScanFile);
    });
  });
}

// Override native FileReader to catch files read by the page itself
// This intercepts when ChatGPT/Grok reads uploaded files
(function() {
  const OrigFileReader = window.FileReader;
  function PatchedFileReader() {
    const reader = new OrigFileReader();
    const origReadAsText = reader.readAsText.bind(reader);
    const origReadAsDataURL = reader.readAsDataURL.bind(reader);
    reader.readAsText = function(blob, encoding) {
      if (blob instanceof File) {
        const origOnLoad = reader.onload;
        reader.addEventListener("load", (e) => {
          try {
            const text = e.target.result;
            if (typeof text === "string" && text.length > 10) {
              scan(text, getAITool() + ` (file: ${blob.name})`);
            }
          } catch(err) {}
        }, { once: true });
      }
      return origReadAsText(blob, encoding);
    };
    return reader;
  }
  PatchedFileReader.prototype = OrigFileReader.prototype;
  try { window.FileReader = PatchedFileReader; } catch(e) {}
})();

// Drag and drop
document.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if (files) Array.from(files).forEach(readAndScanFile);
}, true);

// Paste
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "string" && item.type === "text/plain") {
      item.getAsString(str => { if (str && str.length > 5) scan(str, getAITool() + " (paste)"); });
    }
    if (item.kind === "file") readAndScanFile(item.getAsFile());
  }
}, true);

// ── INPUT DETECTION ───────────────────────────────────────────────────────────
function getText() {
  const selectors = ['div[contenteditable="true"]',"textarea",".ProseMirror",'[role="textbox"]','[class*="editor"]','[class*="prompt"]','[class*="composer"]','[class*="chat"]'];
  const active = document.activeElement;
  if (active && active !== document.body) {
    const t = active.value || active.innerText || active.textContent || "";
    if (t.trim().length > 5) return t.trim();
  }
  for (const s of selectors) {
    for (const el of document.querySelectorAll(s)) {
      const t = el.value || el.innerText || el.textContent || "";
      if (t.trim().length > 5) return t.trim();
    }
  }
  return "";
}

document.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) { const t = getText(); if (t) await scan(t); }
}, true);

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button,[role='button'],[type='submit']");
  if (!btn) return;
  const info = (btn.getAttribute("aria-label")||btn.getAttribute("data-testid")||btn.textContent||"").toLowerCase();
  if (info.includes("send")||info.includes("submit")||info.includes("ask")||btn.getAttribute("type")==="submit") {
    const t = getText(); if (t) await scan(t);
  }
}, true);

document.addEventListener("submit", async () => {
  const t = getText(); if (t) await scan(t);
}, true);

// DOM mutations
new MutationObserver(async (mutations) => {
  let checkInputs = false;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.querySelector?.('input[type="file"]') || node.type === "file") checkInputs = true;
      const userSels = ['[data-message-author-role="user"]','[class*="human"]','[class*="user-turn"]','[class*="user-message"]','[class*="HumanMessage"]','[data-testid*="user"]','[class*="outgoing"]'];
      for (const sel of userSels) {
        const found = node.matches?.(sel) ? node : node.querySelector?.(sel);
        if (found) {
          const t = found.innerText || found.textContent || "";
          if (t.trim().length > 10) await scan(t.trim());
        }
      }
    }
  }
  if (checkInputs) watchFileInputs();
}).observe(document.body, { childList: true, subtree: true });

watchFileInputs();
console.log("Syphir Shield active on", getAITool(), "—", window.location.hostname);