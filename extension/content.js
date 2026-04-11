const SYPHIR_API = "http://localhost:3000";
let SYPHIR_KEY = "SYP-DEMO-2026-SYPHIR";
let USER_EMAIL = "demo@dentalpractice.com";
let lastScanned = "";
let lastScannedTime = 0;

chrome.storage.local.get(["syphir_key", "syphir_email"], (data) => {
  if (data.syphir_key) SYPHIR_KEY = data.syphir_key;
  if (data.syphir_email) USER_EMAIL = data.syphir_email;
  console.log("🛡️ Syphir Shield active on", window.location.hostname);
});

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
  if (h.includes("phind")) return "Phind";
  if (h.includes("deepseek")) return "DeepSeek";
  if (h.includes("groq")) return "Groq";
  return "Unknown AI";
}

function showBanner(message, risk) {
  const old = document.getElementById("syphir-banner");
  if (old) old.remove();
  const bg = risk === "high" ? "#ff4444" : risk === "medium" ? "#ff8800" : "#ffaa00";
  const d = document.createElement("div");
  d.id = "syphir-banner";
  d.style.cssText = `
    position:fixed;top:20px;right:20px;z-index:2147483647;
    background:${bg};border-radius:12px;padding:16px 20px;
    max-width:420px;min-width:300px;color:#fff;
    font-family:-apple-system,sans-serif;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
  `;
  d.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:22px;">🛡️</span>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:14px;">Syphir — Sensitive Data Detected</div>
        <div style="font-size:12px;opacity:0.9;margin-top:3px;">${message}</div>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" style="
        background:rgba(255,255,255,0.2);border:none;color:#fff;
        padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;
      ">✕</button>
    </div>
  `;
  document.body.appendChild(d);
  setTimeout(() => { const b = document.getElementById("syphir-banner"); if (b) b.remove(); }, 8000);
}

async function scan(text) {
  if (!text || text.trim().length < 10) return;
  const now = Date.now();
  if (text.trim() === lastScanned && now - lastScannedTime < 5000) return;
  lastScanned = text.trim();
  lastScannedTime = now;
  console.log("🛡️ Syphir: Scanning:", text.substring(0, 50));
  try {
    const r = await fetch(`${SYPHIR_API}/scan`, {
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
    const result = await r.json();
    console.log("🛡️ Syphir: Result:", result);
    if (result.flagged) {
      showBanner(result.message, result.risk_level);
      chrome.runtime.sendMessage({ type: "INCIDENT_FLAGGED", risk_level: result.risk_level });
    }
  } catch (e) {
    console.log("🛡️ Syphir: Error:", e.message);
  }
}

// Grab text from ANY input on the page
function getText() {
  const selectors = [
    'div[contenteditable="true"]',
    "textarea",
    ".ProseMirror",
    '[role="textbox"]',
    '[data-testid="tweetTextarea_0"]',
    '[class*="editor"]',
    '[class*="input"]',
    '[class*="composer"]',
    '[class*="prompt"]',
    '[class*="message"]',
    '[class*="chat"]',
    '[class*="query"]',
    '[class*="search"]',
  ];

  // Try focused element first
  const active = document.activeElement;
  if (active) {
    const t = active.value || active.innerText || active.textContent || "";
    if (t.trim().length > 5) return t.trim();
  }

  // Try all selectors
  for (const s of selectors) {
    const els = document.querySelectorAll(s);
    for (const el of els) {
      const t = el.value || el.innerText || el.textContent || "";
      if (t.trim().length > 5) return t.trim();
    }
  }
  return "";
}

// Watch Enter key
document.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    const t = getText();
    if (t) await scan(t);
  }
}, true);

// Watch all button clicks broadly
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button, [role='button'], [type='submit']");
  if (!btn) return;
  const info = (
    btn.getAttribute("aria-label") ||
    btn.getAttribute("data-testid") ||
    btn.getAttribute("title") ||
    btn.textContent ||
    btn.className || ""
  ).toLowerCase();

  const isSend =
    info.includes("send") ||
    info.includes("submit") ||
    info.includes("search") ||
    info.includes("ask") ||
    info.includes("go") ||
    btn.getAttribute("type") === "submit" ||
    btn.closest("form");

  if (isSend) {
    const t = getText();
    if (t) await scan(t);
  }
}, true);

// Watch form submits
document.addEventListener("submit", async (e) => {
  const t = getText();
  if (t) await scan(t);
}, true);

// MutationObserver — catches new user messages added to DOM
// Works for React/Vue apps like ChatGPT, Grok, Perplexity
new MutationObserver(async (mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      // Look for user message containers being added
      const userSelectors = [
        '[data-message-author-role="user"]',
        '[class*="human"]',
        '[class*="user-turn"]',
        '[class*="user-message"]',
        '[class*="HumanMessage"]',
        '[class*="UserMessage"]',
        '[data-testid*="user"]',
        '[class*="outgoing"]',
        '[class*="sent"]',
      ];
      for (const sel of userSelectors) {
        const found = node.matches?.(sel) ? node : node.querySelector?.(sel);
        if (found) {
          const t = found.innerText || found.textContent || "";
          if (t.trim().length > 10) {
            console.log("🛡️ Syphir: User message detected via DOM mutation");
            await scan(t.trim());
          }
        }
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

console.log("🛡️ Syphir Shield active on", getAITool(), "—", window.location.hostname);