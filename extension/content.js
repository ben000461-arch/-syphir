 const SYPHIR_API = "https://syphir-api.onrender.com";
let SYPHIR_KEY = "SYP-DEMO-2026-SYPHIR";
let USER_EMAIL = "demo@dentalpractice.com";
let lastScanned = "";
let lastScannedTime = 0;

chrome.storage.local.get(["syphir_key", "syphir_email"], (data) => {
  if (data.syphir_key) SYPHIR_KEY = data.syphir_key;
  if (data.syphir_email) USER_EMAIL = data.syphir_email;
  console.log("Syphir Shield active on", window.location.hostname);
});

// ── LOCAL PII DETECTION (no scanner server needed) ──────────────────────────
const PII_PATTERNS = [
  { type: "SSN",          regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,                                          risk: "high" },
  { type: "CREDIT_CARD",  regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4})\b/g, risk: "high" },
  { type: "API_KEY",      regex: /\bsk-[A-Za-z0-9]{20,}\b|\bsk-ant-[A-Za-z0-9\-_]{20,}\b|\bBearer\s+[A-Za-z0-9\-_.~+\/]+=*\b/g, risk: "high" },
  { type: "MEDICAL_RECORD", regex: /\b(?:MRN|medical\s+record)[\s:#]*\d{4,10}\b/gi,                          risk: "high" },
  { type: "DATE_OF_BIRTH", regex: /\b(?:dob|date\s+of\s+birth)\s*[:\\/]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi, risk: "medium" },
  { type: "EMAIL",        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,                   risk: "low" },
  { type: "PHONE",        regex: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,                  risk: "low" },
  { type: "EIN",          regex: /\b\d{2}-\d{7}\b/g,                                                          risk: "medium" },
  { type: "GENERIC_SECRET", regex: /\b(?:api[_\-]?key|secret[_\-]?key|access[_\-]?token)\s*[:=]\s*['\"]?[A-Za-z0-9\-_]{16,}['\"]?\b/gi, risk: "high" },
];

function detectPII(text) {
  const findings = [];
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0; // reset regex state
    const matches = [...text.matchAll(p.regex)];
    for (const m of matches) {
      const raw = m[0];
      const masked = raw.length > 6 ? raw.slice(0,2) + "****" + raw.slice(-2) : "****";
      findings.push({ type: p.type, masked, risk: p.risk, start: m.index, end: m.index + raw.length });
    }
  }
  return findings;
}

function getRiskLevel(findings) {
  if (findings.some(f => f.risk === "high")) return "high";
  if (findings.some(f => f.risk === "medium")) return "medium";
  return "low";
}

function buildMessage(findings) {
  const types = [...new Set(findings.map(f => f.type.replace(/_/g, " ")))];
  if (types.length === 1) return `${types[0]} detected — remove before sending`;
  if (types.length === 2) return `${types[0]} and ${types[1]} detected — remove before sending`;
  return `${types.slice(0,-1).join(", ")}, and ${types[types.length-1]} detected`;
}

// ── UI ─────────────────────────────────────────────────────────────────────
function getAITool() {
  const h = window.location.hostname;
  if (h.includes("chatgpt") || h.includes("openai")) return "ChatGPT";
  if (h.includes("claude")) return "Claude";
  if (h.includes("gemini") || h.includes("aistudio")) return "Gemini";
  if (h.includes("copilot")) return "Copilot";
  if (h.includes("grok") || h.includes("x.com")) return "Grok";
  if (h.includes("perplexity")) return "Perplexity";
  if (h.includes("mistral")) return "Mistral";
  if (h.includes("huggingface")) return "HuggingFace";
  if (h.includes("poe")) return "Poe";
  if (h.includes("character")) return "Character.AI";
  if (h.includes("you.com")) return "You.com";
  if (h.includes("deepseek")) return "DeepSeek";
  if (h.includes("groq")) return "Groq";
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

  const d = document.createElement("div");
  d.id = "syphir-banner";
  d.style.cssText = `
    position:fixed;top:20px;right:20px;z-index:2147483647;
    background:${c.bg};border:1px solid ${c.border};
    border-radius:12px;padding:14px 16px;
    max-width:400px;min-width:280px;color:#fff;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    box-shadow:0 8px 32px rgba(0,0,0,0.35);
    animation:syphirSlide 0.3s ease;
  `;

  // Add animation
  if (!document.getElementById("syphir-style")) {
    const style = document.createElement("style");
    style.id = "syphir-style";
    style.textContent = `
      @keyframes syphirSlide {
        from { opacity:0; transform:translateX(20px); }
        to   { opacity:1; transform:translateX(0); }
      }
    `;
    document.head.appendChild(style);
  }

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = `
    background:rgba(255,255,255,0.25);border:none;color:#fff;
    padding:3px 8px;border-radius:5px;cursor:pointer;font-size:12px;
    float:right;margin-left:10px;font-family:inherit;
  `;
  closeBtn.addEventListener("click", () => d.remove());

  d.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <span style="font-size:20px;flex-shrink:0;">🛡️</span>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:13px;margin-bottom:3px;">Syphir — Sensitive Data Detected</div>
        <div style="font-size:12px;opacity:0.92;line-height:1.4;">${message}</div>
      </div>
    </div>
  `;
  d.appendChild(closeBtn);
  document.body.appendChild(d);

  // Auto-dismiss after 8 seconds
  setTimeout(() => { const b = document.getElementById("syphir-banner"); if (b) b.remove(); }, 8000);
}

// ── SCAN ───────────────────────────────────────────────────────────────────
async function scan(text) {
  if (!text || text.trim().length < 10) return;
  const now = Date.now();
  if (text.trim() === lastScanned && now - lastScannedTime < 5000) return;
  lastScanned = text.trim();
  lastScannedTime = now;

  // Detect locally — instant, no server needed
  const findings = detectPII(text.trim());
  if (findings.length === 0) return;

  const risk_level = getRiskLevel(findings);
  const message    = buildMessage(findings);

  // Show banner immediately
  showBanner(message, risk_level);

  // Notify background to update badge
  chrome.runtime.sendMessage({ type: "INCIDENT_FLAGGED", risk_level });

  // Log to API (fire and forget — don't block on this)
  try {
    await fetch(`${SYPHIR_API}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text.trim(),
        key: SYPHIR_KEY,
        user_email: USER_EMAIL,
        ai_tool: getAITool(),
        url: window.location.href,
      }),
    });
  } catch (e) {
    // API offline — banner still showed, incident will be missed in dashboard
    // but protection still worked
    console.log("Syphir: API log failed (offline?):", e.message);
  }
}

// ── INPUT DETECTION ────────────────────────────────────────────────────────
function getText() {
  const selectors = [
    'div[contenteditable="true"]',
    "textarea",
    ".ProseMirror",
    '[role="textbox"]',
    '[class*="editor"]',
    '[class*="prompt"]',
    '[class*="message"]',
    '[class*="composer"]',
    '[class*="chat"]',
  ];

  const active = document.activeElement;
  if (active) {
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
  const info = (
    btn.getAttribute("aria-label") || btn.getAttribute("data-testid") ||
    btn.getAttribute("title") || btn.textContent || btn.className || ""
  ).toLowerCase();
  const isSend = info.includes("send") || info.includes("submit") ||
    info.includes("ask") || btn.getAttribute("type") === "submit" || btn.closest("form");
  if (isSend) {
    const t = getText();
    if (t) await scan(t);
  }
}, true);

// Form submits
document.addEventListener("submit", async (e) => {
  const t = getText();
  if (t) await scan(t);
}, true);

// DOM mutations — catches React/Vue apps
new MutationObserver(async (mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const userSelectors = [
        '[data-message-author-role="user"]',
        '[class*="human"]', '[class*="user-turn"]',
        '[class*="user-message"]', '[class*="HumanMessage"]',
        '[class*="UserMessage"]', '[data-testid*="user"]',
        '[class*="outgoing"]', '[class*="sent"]',
      ];
      for (const sel of userSelectors) {
        const found = node.matches?.(sel) ? node : node.querySelector?.(sel);
        if (found) {
          const t = found.innerText || found.textContent || "";
          if (t.trim().length > 10) await scan(t.trim());
        }
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

console.log("Syphir Shield active on", getAITool(), "—", window.location.hostname);