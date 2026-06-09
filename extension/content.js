const SYPHIR_API = "https://syphir-api.onrender.com";
let SYPHIR_KEY = null;
let USER_EMAIL = null;
let lastScanned = "";
let lastScannedTime = 0;
let scannedFiles = new Set();
let bannerDismissed = false;
let syphirExpired = false;

(function loadStoredCredentials(attempt) {
  try {
    chrome.storage.local.get(["syphir_key", "syphir_email", "syphir_expired"], (data) => {
      if (data.syphir_expired) {
        syphirExpired = true;
        wakeAPI();
      } else if (data.syphir_key) {
        SYPHIR_KEY = data.syphir_key;
        USER_EMAIL = data.syphir_email || null;
        wakeAPI();
      } else if (attempt < 3) {
        setTimeout(() => loadStoredCredentials(attempt + 1), 500);
      } else {
        wakeAPI();
      }
    });
  } catch(_) { wakeAPI(); }
})(1);

function wakeAPI() {
  fetch(`${SYPHIR_API}/health`).catch(() => {});
}

// Re-check expiry + credentials every 30 minutes so mid-session renewals
// resume automatically without requiring a page reload.
setInterval(() => {
  if (!chrome?.runtime?.id) return;
  try {
    chrome.storage.local.get(["syphir_key", "syphir_email", "syphir_expired"], (data) => {
      syphirExpired = data.syphir_expired === true;
      if (data.syphir_key)   SYPHIR_KEY  = data.syphir_key;
      if (data.syphir_email) USER_EMAIL  = data.syphir_email;
    });
  } catch(_) {}
}, 30 * 60 * 1000);

// ── PII PATTERNS ──────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  { type: "SSN", regex: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, risk: "high" },
  { type: "SSN", regex: /(?:social\s*security|ssn|s\.s\.n\.?)\D{0,20}(\d[\d\s\-]{6,12}\d)/gi, risk: "high" },
  { type: "CREDIT_CARD", regex: /\b4\d{12}(?:\d{3})?\b|\b5[1-5]\d{14}\b|\b3[47]\d{13}\b|\b6(?:011|5\d{2})\d{12}\b/g, risk: "high" },
  { type: "CREDIT_CARD", regex: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{1,4}\b/g, risk: "high" },
  { type: "CREDIT_CARD", regex: /(?:credit\s*card|card\s*(?:number|num|no\.?|#))[^a-zA-Z\n]{0,30}(\d[\d\s\-\.]{10,25}\d)/gi, risk: "high" },
  { type: "API_KEY", regex: /\bsk-[A-Za-z0-9]{20,}\b|\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g, risk: "high" },
  { type: "API_KEY", regex: /\bBearer\s+[A-Za-z0-9\-_.~+\/]{20,}=*\b/g, risk: "high" },
  { type: "API_KEY", regex: /(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token)\s*[:=]\s*["']?[A-Za-z0-9\-_]{16,}["']?/gi, risk: "high" },
  { type: "MEDICAL_RECORD", regex: /\bMRN[-:\s]*\d{4,10}\b/gi, risk: "high" },
  { type: "MEDICAL_RECORD", regex: /medical\s*record\s*(?:number|num|#)?\s*[:=\-]?\s*\d{4,10}/gi, risk: "high" },
  { type: "DATE_OF_BIRTH", regex: /(?:dob|date\s+of\s+birth|born\s+on)\s*[:\-\/]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/gi, risk: "medium" },
  { type: "BANK_ACCOUNT", regex: /(?:routing\s*(?:number|num|#)?)\s*[:=\-]?\s*\d{9}/gi, risk: "high" },
  { type: "BANK_ACCOUNT", regex: /(?:account\s*(?:number|num|#))\s*[:=\-]?\s*\d{6,17}/gi, risk: "high" },
  { type: "EIN", regex: /\b\d{2}-\d{7}\b/g, risk: "medium" },
  { type: "PASSPORT", regex: /(?:passport)\s*(?:number|num|#)?\s*[:=\-]?\s*[A-Z]{1,2}\d{6,9}/gi, risk: "high" },
  { type: "DRIVERS_LICENSE", regex: /(?:driver.{0,5}licen[sc]e|dl\s*(?:number|num|#))\s*[:=\-]?\s*[A-Z0-9]{6,15}/gi, risk: "high" },
  { type: "INSURANCE_ID", regex: /(?:policy\s*(?:number|num|#)|member\s*id|insurance\s*(?:id|number))\s*[:=\-]?\s*[A-Z0-9\-]{4,20}/gi, risk: "medium" },
  { type: "EMAIL", regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, risk: "low" },
  { type: "PHONE", regex: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, risk: "low" },
  { type: "SENSITIVE_ID", regex: /(?:patient\s*id|client\s*id|member\s*number|employee\s*id)\s*[:=\-]?\s*\d{4,}/gi, risk: "medium" },
  { type: "MEDICAL_INFO", regex: /(?:diagnosis|prescribed|medication|treatment plan)\s*[:=]?\s*[A-Za-z][\w\s,]{10,60}/gi, risk: "medium" },
];

// ── CODE SECRET PATTERNS ──────────────────────────────────────────────────────
// Only applied when text is code-like (see isCodeLike()).
const CODE_SECRET_PATTERNS = [
  // HIGH — AWS
  { type: "API_KEY",             regex: /AKIA[0-9A-Z]{16}/g,                                                                                         risk: "high" },
  // HIGH — Private key header
  { type: "PRIVATE_KEY",         regex: /-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----/g,                                                                   risk: "high" },
  // HIGH — JWT
  { type: "JWT_TOKEN",           regex: /eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}/g,                                        risk: "high" },
  // HIGH — Stripe live keys
  { type: "API_KEY",             regex: /sk_live_[0-9a-zA-Z]{24,}/g,                                                                                  risk: "high" },
  { type: "API_KEY",             regex: /rk_live_[0-9a-zA-Z]{24,}/g,                                                                                  risk: "high" },
  // HIGH — Generic API key assignments
  { type: "API_KEY",             regex: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[=:]\s*['"][^'"]{8,}['"]/gi, risk: "high" },
  // HIGH — DB connection strings with credentials
  { type: "DB_CREDENTIAL",       regex: /(?:postgres|mysql|mongodb|redis):\/\/[^:\/\s]+:[^@\s]+@[^\s'"]+/gi,                                           risk: "high" },
  // HIGH — OAuth / Bearer tokens
  { type: "OAUTH_TOKEN",         regex: /(?:bearer\s+|token[=:\s]+['"]?)(?:ya29\.|ghp_|gho_|ghu_|xoxb-|xoxp-)[A-Za-z0-9\-_]+/gi,                     risk: "high" },
  // HIGH — GitHub tokens
  { type: "API_KEY",             regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,                                                                                risk: "high" },
  // HIGH — Hardcoded passwords
  { type: "HARDCODED_PASSWORD",  regex: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{4,}['"]/gi,                                                        risk: "high" },
  // HIGH — OpenAI / Anthropic keys
  { type: "API_KEY",             regex: /sk-[a-zA-Z0-9]{32,}/g,                                                                                       risk: "high" },
  { type: "API_KEY",             regex: /sk-ant-[a-zA-Z0-9\-_]{40,}/g,                                                                                risk: "high" },
  // HIGH — Twilio / SendGrid
  { type: "API_KEY",             regex: /(?:AC|SK)[a-f0-9]{32}/g,                                                                                     risk: "high" },
  { type: "API_KEY",             regex: /SG\.[a-zA-Z0-9\-_]{22,}/g,                                                                                   risk: "high" },
  // MEDIUM — SQL touching sensitive tables
  { type: "SQL_SENSITIVE",       regex: /(?:SELECT|UPDATE|DELETE|INSERT)\s+.{0,50}\s+(?:FROM|INTO|SET)\s+(?:users|customers|accounts|payments|passwords|credentials|sessions|tokens)/gi, risk: "medium" },
  // MEDIUM — DROP/TRUNCATE statements
  { type: "SQL_SENSITIVE",       regex: /(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\s+\w+/gi,                                                     risk: "medium" },
  // MEDIUM — Internal URLs / private endpoints
  { type: "INTERNAL_URL",        regex: /https?:\/\/(?:internal|prod|staging|admin|dev|localhost|192\.168|10\.\d+\.\d+|172\.\d+\.\d+)\b[^\s'"]{0,100}/gi, risk: "medium" },
  // MEDIUM — Sensitive function calls
  { type: "SENSITIVE_FUNCTION",  regex: /(?:getSSN|getPassword|getCreditCard|processPayment|getUserSecret|getPrivateKey|decryptData)\s*\(/gi,            risk: "medium" },
  // LOW — Commented-out credentials
  { type: "COMMENTED_CREDENTIAL", regex: /\/\/.*(?:password|api.?key|secret|token)\s*[=:]\s*['"][^'"]+['"]/gi,                                         risk: "low" },
  { type: "COMMENTED_CREDENTIAL", regex: /#.*(?:password|api.?key|secret|token)\s*[=:]\s*['"][^'"]+['"]/gi,                                            risk: "low" },
  // LOW — console.log leaking secrets
  { type: "CONSOLE_LOG_SECRET",   regex: /console\.log\s*\([^)]*(?:password|ssn|credit.?card|api.?key|secret|token)[^)]*\)/gi,                         risk: "low" },
  // LOW — TODO security comments
  { type: "COMMENTED_CREDENTIAL", regex: /(?:TODO|FIXME|HACK).*(?:password|secret|key|token|security)/gi,                                             risk: "low" },
];

// Minimum 2 code indicators to classify text as code.
function isCodeLike(text) {
  const indicators = ['{', '}', '=', ';', '=>', 'function', 'def ', 'const ', 'var ', 'class ', 'import ', 'require('];
  let count = 0;
  for (const ind of indicators) {
    if (text.includes(ind)) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

function maskSecret(raw) {
  if (!raw || raw.length <= 4) return "****";
  return raw.slice(0, 4) + "****";
}

// ── LABEL MAPS ────────────────────────────────────────────────────────────────
const PII_LABELS = {
  SSN:           "SSN detected — remove before sending",
  CREDIT_CARD:   "Credit card number detected",
  EMAIL:         "Email address detected",
  PHONE:         "Phone number detected",
  DATE_OF_BIRTH: "Date of birth detected",
  EIN:           "Tax ID (EIN) detected",
};

const CODE_SECRET_LABELS = {
  API_KEY:              (n) => `API Key detected on line ${n}`,
  JWT_TOKEN:            (n) => `JWT Token detected on line ${n}`,
  DB_CREDENTIAL:        (n) => `Database credential on line ${n}`,
  HARDCODED_PASSWORD:   (n) => `Hardcoded password on line ${n}`,
  PRIVATE_KEY:          (n) => `Private key detected on line ${n}`,
  OAUTH_TOKEN:          (n) => `OAuth token on line ${n}`,
  SQL_SENSITIVE:        (n) => `Sensitive SQL query on line ${n}`,
  INTERNAL_URL:         (n) => `Internal URL on line ${n}`,
  SENSITIVE_FUNCTION:   (n) => `Sensitive function call on line ${n}`,
  COMMENTED_CREDENTIAL: (n) => `Commented credential on line ${n}`,
  CONSOLE_LOG_SECRET:   (n) => `Secret in console.log on line ${n}`,
};

function getPIILabel(type) {
  return PII_LABELS[type] || type.replace(/_/g, " ");
}

// ── DETECTION ─────────────────────────────────────────────────────────────────
function detectPII(text) {
  const findings = [];
  const seen = new Set();
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0;
    try {
      const matches = [...text.matchAll(p.regex)];
      for (const m of matches) {
        const raw = m[0];
        const key = p.type + "|" + raw.replace(/\s/g, "").slice(0, 12);
        if (seen.has(key)) continue;
        seen.add(key);
        const masked = raw.length > 6 ? raw.slice(0, 2) + "****" + raw.slice(-2) : "****";
        findings.push({ type: p.type, masked, risk: p.risk, label: getPIILabel(p.type), lineNum: null, isCode: false });
      }
    } catch(e) {}
  }
  return findings;
}

// Single-pass line-by-line scan for code secrets.
function detectCodeSecrets(text) {
  const findings = [];
  const seen = new Set();
  const lines = text.split('\n');

  lines.forEach((line, lineIndex) => {
    const lineNum = lineIndex + 1;
    for (const p of CODE_SECRET_PATTERNS) {
      try {
        p.regex.lastIndex = 0;
        const matches = [...line.matchAll(p.regex)];
        for (const m of matches) {
          const raw = m[0];
          const dedupeKey = p.type + "|" + lineNum + "|" + raw.slice(0, 8);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const masked = maskSecret(raw);
          const labelFn = CODE_SECRET_LABELS[p.type];
          const label = labelFn ? labelFn(lineNum) : `${p.type.replace(/_/g, " ")} on line ${lineNum}`;
          findings.push({ type: p.type, masked, risk: p.risk, label, lineNum, isCode: true });
        }
      } catch(e) {}
    }
  });

  return findings;
}

function getRiskLevel(f) {
  if (f.some(x => x.risk === "high"))   return "high";
  if (f.some(x => x.risk === "medium")) return "medium";
  return "low";
}

function buildMessage(findings) {
  const labels = [...new Set(findings.map(f => f.label))];
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
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

const RISK_ORDER = { high: 0, medium: 1, low: 2 };

// Accepts findings array (new) or a plain string message (legacy file-scan calls).
function showBanner(findingsOrMessage, risk) {
  try {
    const isArray = Array.isArray(findingsOrMessage);
    const rawFindings = isArray
      ? findingsOrMessage
      : [{ type: "NOTICE", label: findingsOrMessage, risk: risk || "medium", masked: "", lineNum: null, isCode: false }];

    const old = document.getElementById("syphir-banner");
    if (old) old.remove();

    if (!document.getElementById("syphir-style")) {
      const s = document.createElement("style");
      s.id = "syphir-style";
      s.textContent = `@keyframes syphirSlide{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}`;
      document.head.appendChild(s);
    }

    // Deduplicate: PII by type, code secrets by type+lineNum
    const piiSeen = new Set();
    const codeSeen = new Set();
    const piiDeduped = [];
    const codeDeduped = [];

    for (const f of rawFindings) {
      if (f.isCode) {
        const k = f.type + "|" + f.lineNum;
        if (!codeSeen.has(k)) { codeSeen.add(k); codeDeduped.push(f); }
      } else {
        if (!piiSeen.has(f.type)) { piiSeen.add(f.type); piiDeduped.push(f); }
      }
    }

    piiDeduped.sort((a, b) => (RISK_ORDER[a.risk] || 2) - (RISK_ORDER[b.risk] || 2));
    codeDeduped.sort((a, b) => (RISK_ORDER[a.risk] || 2) - (RISK_ORDER[b.risk] || 2));

    // PII first, then code secrets
    const allItems = [...piiDeduped, ...codeDeduped];
    const MAX = 5;
    const overflow = allItems.length > MAX ? allItems.length - MAX : 0;
    const displayItems = allItems.slice(0, MAX);

    const ITEM_COLORS = { high: "#f85149", medium: "#e3b341", low: "#8b949e" };
    const headerColor = ITEM_COLORS[risk] || ITEM_COLORS.medium;
    const borderColor = risk === "high" ? "#a02020" : risk === "medium" ? "#9a7a1a" : "#4a5568";

    const d = document.createElement("div");
    d.id = "syphir-banner";
    d.style.cssText = `position:fixed;top:20px;right:20px;z-index:2147483647;background:#0d1117;border:1px solid ${borderColor};border-radius:12px;max-width:420px;min-width:300px;color:#e6edf3;font-family:-apple-system,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.6);animation:syphirSlide 0.3s ease;overflow:hidden;`;

    // Header bar
    const header = document.createElement("div");
    header.style.cssText = `background:${headerColor};padding:9px 13px;display:flex;align-items:center;justify-content:space-between;gap:8px;`;

    const headerTitle = document.createElement("div");
    headerTitle.style.cssText = `font-weight:700;font-size:12px;color:#fff;display:flex;align-items:center;gap:6px;`;
    headerTitle.innerHTML = `<span>🛡</span><span>Syphir — Sensitive Data Detected</span>`;

    const x = document.createElement("button");
    x.textContent = "✕";
    x.style.cssText = `background:rgba(255,255,255,0.25);border:none;color:#fff;padding:2px 7px;border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;line-height:1.5;`;
    x.addEventListener("click", () => d.remove());

    header.appendChild(headerTitle);
    header.appendChild(x);

    // Detection items
    const itemsDiv = document.createElement("div");
    itemsDiv.style.cssText = `padding:10px 14px 4px;`;

    for (const f of displayItems) {
      const item = document.createElement("div");
      const color = ITEM_COLORS[f.risk] || ITEM_COLORS.low;
      item.style.cssText = `font-size:11.5px;color:${color};padding:3px 0;display:flex;align-items:flex-start;gap:6px;line-height:1.4;`;
      item.innerHTML = `<span style="flex-shrink:0;margin-top:1px;">●</span><span>${f.label}</span>`;
      itemsDiv.appendChild(item);
    }

    if (overflow > 0) {
      const more = document.createElement("div");
      more.style.cssText = `font-size:11px;color:#8b949e;padding:3px 0 1px;`;
      more.textContent = `+ ${overflow} more detection${overflow === 1 ? "" : "s"}`;
      itemsDiv.appendChild(more);
    }

    // Dismiss button — suppresses re-display until new input triggers a detection
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.style.cssText = `display:block;width:calc(100% - 28px);margin:8px 14px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);color:#c9d1d9;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:-apple-system,sans-serif;text-align:center;`;
    dismiss.addEventListener("click", () => { bannerDismissed = true; d.remove(); });

    d.appendChild(header);
    d.appendChild(itemsDiv);
    d.appendChild(dismiss);
    document.body.appendChild(d);

    setTimeout(() => { const b = document.getElementById("syphir-banner"); if (b) b.remove(); }, 8000);
  } catch(e) {}
}

// ── LOG INCIDENT ──────────────────────────────────────────────────────────────
// key and email are passed in — resolved by the caller before this is invoked.
// No chrome APIs used here; fetch fires unconditionally.
async function logIncident(findings, risk_level, message, ai_tool, key, email) {
  if (!key) { console.warn('Syphir: no key loaded, skipping log'); return; }
  const incident = {
    id: `inc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    key:        key   || SYPHIR_KEY,
    user_email: email || USER_EMAIL,
    ai_tool:    ai_tool || getAITool(),
    url:        window.location.href,
    risk_level,
    flagged: true,
    detections: findings.map(f => ({
      label:   f.label,
      type:    f.type,
      masked:  f.masked,
      lineNum: f.lineNum  || null,
      isCode:  f.isCode   || false,
    })),
    message,
    timestamp: new Date().toISOString(),
  };
  console.log('Syphir: firing log-incident fetch', incident.key, incident.user_email);
  const response = await fetch(`${SYPHIR_API}/log-incident`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(incident),
  });
  console.log('Syphir: log-incident response:', response.status);
}

// ── SCAN TEXT ─────────────────────────────────────────────────────────────────
async function scan(text, source) {
  if (syphirExpired) return;
  if (!text || text.trim().length < 5) return;
  const now = Date.now();
  const trimmed = text.trim();
  if (trimmed === lastScanned && now - lastScannedTime < 5000) return;

  const isNewText = trimmed !== lastScanned;
  lastScanned = trimmed;
  lastScannedTime = now;

  try {
    const piiFindings  = detectPII(trimmed);
    const codeFindings = isCodeLike(trimmed) ? detectCodeSecrets(trimmed) : [];
    const findings = [...piiFindings, ...codeFindings];

    if (!findings.length) return;

    const risk_level = getRiskLevel(findings);
    const message    = buildMessage(findings);
    const tool       = source || getAITool();

    // Read key/email from storage before logging
    let key = SYPHIR_KEY, email = USER_EMAIL;
    if (chrome?.runtime?.id) {
      try {
        const stored = await new Promise(resolve => {
          chrome.storage.local.get(["syphir_key", "syphir_email"], resolve);
        });
        if (stored.syphir_key)   key   = stored.syphir_key;
        if (stored.syphir_email) email = stored.syphir_email;
      } catch(_) {}
    }

    // Logging fires immediately and unconditionally — no UI setting gates this
    const logPromise = logIncident(findings, risk_level, message, tool, key, email)
      .catch(e => console.error('Syphir: log-incident error:', e));
    try {
      if (chrome?.runtime?.id) chrome.runtime.sendMessage({ type: "INCIDENT_FLAGGED", risk_level });
    } catch(e) {}

    // Reset dismissed state when a genuinely new input triggers a detection
    if (isNewText) bannerDismissed = false;

    // Check popup "Hide Alerts" setting — only gates the banner, never the log
    let hideAlerts = false;
    if (chrome?.runtime?.id) {
      try {
        hideAlerts = await new Promise(resolve => {
          chrome.storage.local.get(["syphir_hide_alerts"], (d) => resolve(d.syphir_hide_alerts === true));
        });
      } catch(_) {}
    }

    if (!bannerDismissed && !hideAlerts) showBanner(findings, risk_level);

    await logPromise;
  } catch(e) {
    console.error('Syphir: scan error:', e);
  }
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
(function() {
  const OrigFileReader = window.FileReader;
  function PatchedFileReader() {
    const reader = new OrigFileReader();
    const origReadAsText = reader.readAsText.bind(reader);
    reader.readAsText = function(blob, encoding) {
      if (blob instanceof File) {
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
  const selectors = ['div[contenteditable="true"]', "textarea", ".ProseMirror", '[role="textbox"]', '[class*="editor"]', '[class*="prompt"]', '[class*="composer"]', '[class*="chat"]'];
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
  const info = (btn.getAttribute("aria-label") || btn.getAttribute("data-testid") || btn.textContent || "").toLowerCase();
  if (info.includes("send") || info.includes("submit") || info.includes("ask") || btn.getAttribute("type") === "submit") {
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
      const userSels = ['[data-message-author-role="user"]', '[class*="human"]', '[class*="user-turn"]', '[class*="user-message"]', '[class*="HumanMessage"]', '[data-testid*="user"]', '[class*="outgoing"]'];
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
