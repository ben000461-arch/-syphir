// CRON: POST /admin/send-weekly-reports   — every Monday    8:00 AM PST  (X-Admin-Secret: [ADMIN_SECRET])
// CRON: POST /admin/send-expiry-warnings  — every day       9:00 AM PST  (X-Admin-Secret: [ADMIN_SECRET])
// CRON: POST /admin/send-expiry-notices   — every day       9:05 AM PST  (X-Admin-Secret: [ADMIN_SECRET])

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Resend } from "resend";
import Stripe from "stripe";

const app = new Hono();
const SCANNER_URL = "https://syphir-scanner.onrender.com";
const SUPABASE_URL = "https://pfrojobhrmfnoxavlrmm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const resend = new Resend(process.env.RESEND_API_KEY || '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
if (!ADMIN_SECRET) console.warn('WARNING: ADMIN_SECRET env var is not set — admin endpoints will reject all requests');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const STRIPE_PLANS = {
  Starter:      { amount: 12900, label: "Syphir Starter — $129/mo" },
  Professional: { amount: 29900, label: "Syphir Professional — $299/mo" },
  Institution:  { amount: 59900, label: "Syphir Institution — $599/mo" },
};

const PLAN_DETAILS = {
  Starter:      { price: "$129/mo", limit: "Up to 15 employees" },
  Professional: { price: "$299/mo", limit: "Up to 50 employees" },
  Institution:  { price: "$599/mo", limit: "Unlimited employees" },
};

function genKey() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const s = n => Array.from({length:n}, () => c[Math.floor(Math.random()*c.length)]).join("");
  return `SYP-${s(4)}-${s(4)}-${s(4)}`;
}
function genEmpKey() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const s = n => Array.from({length:n}, () => c[Math.floor(Math.random()*c.length)]).join("");
  return `EMP-${s(4)}-${s(4)}`;
}

// ── EMAIL BUILDERS ─────────────────────────────────────────────────────────

const EMAIL_FROM    = "Syphir Shield <onboarding@resend.dev>";
const EMAIL_REPLYTO = "syphir26@gmail.com";

function emailFooter(orgName) {
  return `<div style="padding-top:20px;border-top:1px solid #1e2636;text-align:center;margin-top:8px;">
    <p style="font-size:11px;color:#4a5568;margin:0;">Syphir AI Data Protection &middot; <a href="https://syphir.vercel.app" style="color:#4a5568;text-decoration:none;">syphir.vercel.app</a> &middot; <a href="mailto:syphir26@gmail.com" style="color:#4a5568;text-decoration:none;">syphir26@gmail.com</a></p>
    <p style="font-size:11px;color:#4a5568;margin:6px 0 0;">You're receiving this as admin of ${orgName}</p>
  </div>`;
}

function emailHeader(rightLabel, rightSub) {
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #1e2636;">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="font-size:20px;">&#x1F6E1;&#xFE0F;</span>
        <span style="font-size:18px;font-weight:800;color:#e6edf3;">Syphir</span>
      </div>
      <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:0.08em;">AI Data Protection</div>
    </div>
    ${rightLabel ? `<div style="text-align:right;"><div style="font-size:11px;font-weight:700;color:#2DD4BF;text-transform:uppercase;letter-spacing:0.06em;">${rightLabel}</div><div style="font-size:11px;color:#8b949e;margin-top:2px;">${rightSub||''}</div></div>` : ''}
  </div>`;
}

function riskBadge(r) {
  const bg = r === 'high' ? '#ef4444' : r === 'medium' ? '#f59e0b' : '#6b7280';
  return `<span style="background:${bg};color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;text-transform:uppercase;">${r||'—'}</span>`;
}

function buildIncidentCsv(incidents) {
  const hdr = 'ID,User,AI Tool,Risk,Detections,Time,Resolved\n';
  const rows = incidents.map(i => {
    const dets = Array.isArray(i.detections) ? i.detections.map(d => d.type || d.label || '').filter(Boolean).join('; ') : '';
    return [i.id||'', i.user_email||'', i.ai_tool||'', i.risk_level||'', dets, i.timestamp||'', i.resolved ? 'Yes' : 'No']
      .map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
  }).join('\n');
  return hdr + rows;
}

function buildWeeklyReportHtml(org, incidents, orgKey, weekStart, weekEnd) {
  const total    = incidents.length;
  const high     = incidents.filter(i => i.risk_level === 'high').length;
  const low      = incidents.filter(i => i.risk_level === 'low').length;
  const resolved = incidents.filter(i => i.resolved).length;
  const byTool   = {};
  incidents.forEach(i => { byTool[i.ai_tool||'Unknown'] = (byTool[i.ai_tool||'Unknown']||0) + 1; });

  const summary = high > 3
    ? `This week Syphir caught ${total} incidents at <strong>${org.name}</strong> — including ${high} high-risk detections. <span style="color:#f87171;">Immediate review recommended.</span>`
    : total > 5
      ? `Your team had ${total} incidents this week. ${high} were high-risk and warrant a closer look.`
      : `A quiet week — ${total} incident${total!==1?'s':''} detected, mostly low-risk. Your team appears to be handling data carefully.`;

  const topRows = incidents.slice(0,5).map(i => {
    const dets = Array.isArray(i.detections) ? i.detections.map(d=>d.type||d.label||'').filter(Boolean).join(', ') : '—';
    return `<tr>
      <td style="padding:8px 10px;font-size:12px;color:#e6edf3;border-bottom:1px solid #1e2636;">${i.user_email||'—'}</td>
      <td style="padding:8px 10px;font-size:12px;color:#8b949e;border-bottom:1px solid #1e2636;">${i.ai_tool||'—'}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1e2636;">${riskBadge(i.risk_level)}</td>
      <td style="padding:8px 10px;font-size:11px;color:#8b949e;border-bottom:1px solid #1e2636;">${dets}</td>
      <td style="padding:8px 10px;font-size:11px;color:#8b949e;border-bottom:1px solid #1e2636;">${i.timestamp ? new Date(i.timestamp).toLocaleDateString() : '—'}</td>
    </tr>`;
  }).join('');

  const toolList = Object.entries(byTool).sort((a,b)=>b[1]-a[1])
    .map(([t,n]) => `<li style="font-size:12px;color:#8b949e;margin-bottom:4px;"><strong style="color:#e6edf3;">${t}</strong> — ${n} detection${n!==1?'s':''}</li>`).join('');

  const dashUrl = `https://syphir.vercel.app/app.html?key=${orgKey}`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  ${emailHeader('Weekly Report', `${weekStart} &mdash; ${weekEnd}`)}
  <div style="font-size:22px;font-weight:800;color:#e6edf3;margin-bottom:8px;">${org.name}</div>
  <p style="font-size:14px;color:#8b949e;line-height:1.6;margin:0 0 24px;">${summary}</p>
  <table width="100%" cellpadding="0" cellspacing="6" style="margin-bottom:24px;">
    <tr>
      <td style="background:#161b25;border:1px solid #1e2636;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#e6edf3;font-family:'Courier New',monospace;">${total}</div>
        <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.07em;margin-top:3px;">Total</div>
      </td>
      <td style="background:#161b25;border:1px solid #1e2636;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#ef4444;font-family:'Courier New',monospace;">${high}</div>
        <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.07em;margin-top:3px;">High Risk</div>
      </td>
      <td style="background:#161b25;border:1px solid #1e2636;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#f59e0b;font-family:'Courier New',monospace;">${low}</div>
        <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.07em;margin-top:3px;">Low Risk</div>
      </td>
      <td style="background:#161b25;border:1px solid #1e2636;border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:26px;font-weight:800;color:#2DD4BF;font-family:'Courier New',monospace;">${resolved}</div>
        <div style="font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.07em;margin-top:3px;">Resolved</div>
      </td>
    </tr>
  </table>
  <div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;overflow:hidden;margin-bottom:24px;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e2636;">
      <span style="font-size:12px;font-weight:700;color:#e6edf3;text-transform:uppercase;letter-spacing:0.07em;">Top Detections</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <thead><tr style="background:#0d1117;">
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#8b949e;text-transform:uppercase;">User</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#8b949e;text-transform:uppercase;">AI Tool</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#8b949e;text-transform:uppercase;">Risk</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#8b949e;text-transform:uppercase;">Type</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:600;color:#8b949e;text-transform:uppercase;">Date</th>
      </tr></thead>
      <tbody>${topRows}</tbody>
    </table>
  </div>
  ${Object.keys(byTool).length ? `<div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;padding:16px;margin-bottom:24px;">
    <div style="font-size:12px;font-weight:700;color:#e6edf3;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px;">AI Tools Used</div>
    <ul style="margin:0;padding:0;list-style:none;">${toolList}</ul>
  </div>` : ''}
  <p style="font-size:12px;color:#8b949e;margin:0 0 24px;">&#128206; Full incident log attached as CSV</p>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${dashUrl}" style="display:inline-block;background:#2DD4BF;color:#0d1117;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">View Dashboard &#8594;</a>
  </div>
  ${emailFooter(org.name)}
</div></body></html>`;
}

function buildQuietWeekHtml(org, weekStart, weekEnd, orgKey) {
  const dashUrl = `https://syphir.vercel.app/app.html?key=${orgKey}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  ${emailHeader('Weekly Report', `${weekStart} &mdash; ${weekEnd}`)}
  <div style="font-size:22px;font-weight:800;color:#e6edf3;margin-bottom:20px;">${org.name}</div>
  <div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;padding:28px;margin-bottom:24px;text-align:center;">
    <div style="font-size:40px;margin-bottom:12px;">&#x2705;</div>
    <div style="font-size:16px;font-weight:700;color:#2DD4BF;margin-bottom:8px;">All Clear This Week</div>
    <p style="font-size:14px;color:#8b949e;margin:0;line-height:1.6;">No PII incidents were detected at ${org.name} in the past 7 days. Your team handled their AI tool usage carefully.</p>
  </div>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${dashUrl}" style="display:inline-block;background:#2DD4BF;color:#0d1117;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">View Dashboard &#8594;</a>
  </div>
  ${emailFooter(org.name)}
</div></body></html>`;
}

function buildExpiryWarningHtml(org, expiryDate, total, proofLine) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  ${emailHeader('', '')}
  <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:10px;padding:20px;margin-bottom:24px;">
    <div style="font-size:13px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">&#x23F0; Trial Ending Soon</div>
    <div style="font-size:20px;font-weight:800;color:#e6edf3;">Your Syphir trial ends on ${expiryDate}</div>
  </div>
  <p style="font-size:14px;color:#8b949e;line-height:1.6;margin:0 0 16px;">During your trial, Syphir detected <strong style="color:#e6edf3;">${total} incident${total!==1?'s':''}</strong> across your team.${proofLine ? ' ' + proofLine : ''}</p>
  <p style="font-size:14px;color:#8b949e;line-height:1.6;margin:0 0 24px;">After your trial ends, Syphir's protection will pause and incidents will no longer be monitored or logged.</p>
  <div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;padding:16px;margin-bottom:24px;">
    <div style="font-size:12px;font-weight:700;color:#e6edf3;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.07em;">Choose a Plan to Continue</div>
    <div style="margin-bottom:8px;font-size:13px;color:#8b949e;"><strong style="color:#e6edf3;">Starter</strong> &mdash; $129/mo &middot; Up to 15 employees</div>
    <div style="font-size:13px;color:#8b949e;"><strong style="color:#e6edf3;">Professional</strong> &mdash; $299/mo &middot; Up to 50 employees</div>
  </div>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="https://syphir.vercel.app/pricing.html" style="display:inline-block;background:#f59e0b;color:#0d1117;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">Upgrade Now &#8594;</a>
  </div>
  ${emailFooter(org.name)}
</div></body></html>`;
}

function buildExpiryNoticeHtml(org, expiryDate, total) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  ${emailHeader('', '')}
  <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:20px;margin-bottom:24px;">
    <div style="font-size:13px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">&#x1F512; Protection Paused</div>
    <div style="font-size:20px;font-weight:800;color:#e6edf3;">Your Syphir trial ended on ${expiryDate}</div>
  </div>
  <p style="font-size:14px;color:#8b949e;line-height:1.6;margin:0 0 16px;">During your trial, Syphir detected <strong style="color:#e6edf3;">${total} incident${total!==1?'s':''}</strong>. Your team is now unprotected.</p>
  <p style="font-size:14px;color:#ef4444;font-weight:600;line-height:1.6;margin:0 0 24px;">Every day without Syphir is a day your team's AI activity goes unmonitored.</p>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="https://syphir.vercel.app/pricing.html" style="display:inline-block;background:#ef4444;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">Restore Protection &#8594;</a>
  </div>
  ${emailFooter(org.name)}
</div></body></html>`;
}

function buildUpgradeConfirmationHtml(org, plan, bizKey, empKey) {
  const planInfo  = PLAN_DETAILS[plan] || {};
  const dashUrl   = `https://syphir.vercel.app/app.html?key=${bizKey}`;
  const installUrl = empKey ? `https://syphir.vercel.app/install.html?key=${empKey}` : 'https://syphir.vercel.app/install.html';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  ${emailHeader('', '')}
  <div style="background:rgba(45,212,191,0.08);border:1px solid rgba(45,212,191,0.25);border-radius:10px;padding:24px;margin-bottom:24px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">&#x2705;</div>
    <div style="font-size:20px;font-weight:800;color:#e6edf3;margin-bottom:4px;">Welcome to Syphir ${plan}</div>
    <div style="font-size:14px;color:#2DD4BF;">Your team is now fully protected.</div>
  </div>
  <div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Dashboard Key</div>
    <div style="font-family:'Courier New',monospace;font-size:16px;font-weight:700;color:#2DD4BF;letter-spacing:0.05em;">${bizKey}</div>
    <div style="font-size:11px;color:#8b949e;margin-top:4px;">Save this key — you'll need it every time you log in to your dashboard.</div>
  </div>
  ${empKey ? `<div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Employee Install Link</div>
    <a href="${installUrl}" style="color:#2DD4BF;font-size:12px;word-break:break-all;text-decoration:none;">${installUrl}</a>
    <div style="font-size:11px;color:#8b949e;margin-top:4px;">Share this with your team — they install in 60 seconds, no setup needed.</div>
  </div>` : ''}
  <div style="background:#161b25;border:1px solid #1e2636;border-radius:10px;padding:16px;margin-bottom:24px;">
    <div style="font-size:12px;font-weight:700;color:#e6edf3;margin-bottom:8px;">${plan} Plan</div>
    ${planInfo.price ? `<div style="font-size:13px;color:#8b949e;margin-bottom:4px;">Price: <strong style="color:#e6edf3;">${planInfo.price}</strong></div>` : ''}
    ${planInfo.limit ? `<div style="font-size:13px;color:#8b949e;">Team size: <strong style="color:#e6edf3;">${planInfo.limit}</strong></div>` : ''}
  </div>
  <div style="text-align:center;margin-bottom:24px;">
    <a href="${dashUrl}" style="display:inline-block;background:#2DD4BF;color:#0d1117;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">Open Dashboard &#8594;</a>
  </div>
  <p style="font-size:12px;color:#8b949e;text-align:center;margin:0 0 24px;">Questions? Reply to this email or contact <a href="mailto:syphir26@gmail.com" style="color:#2DD4BF;text-decoration:none;">syphir26@gmail.com</a></p>
  ${emailFooter(org.name)}
</div></body></html>`;
}

// ── SUPABASE HELPER ────────────────────────────────────────────────────────
async function db(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": options.prefer || "return=representation",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── RETRY WRAPPER — survives Render free-tier spin-down mid-request ────────
async function dbWithRetry(path, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await db(path, options);
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`DB retry ${i + 1}/${retries - 1} for ${path}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ── DEDUP HELPER — block same org+user+ai_tool within 60 seconds ──────────
async function isDuplicateIncident(orgId, userEmail, aiTool) {
  try {
    const since = new Date(Date.now() - 60_000).toISOString();
    const rows = await db(
      `incidents?org_id=eq.${encodeURIComponent(orgId)}&user_email=eq.${encodeURIComponent(userEmail)}&ai_tool=eq.${encodeURIComponent(aiTool)}&timestamp=gte.${encodeURIComponent(since)}&select=id&limit=1`
    );
    return rows && rows.length > 0;
  } catch (_) {
    return false; // non-fatal: if check fails, allow the write
  }
}

// ── CORS ───────────────────────────────────────────────────────────────────
// Extension content scripts fire fetches from AI tool page origins
// (chatgpt.com, grok.com, etc) — not chrome-extension://. Auth is key-based
// so wildcard origin gives no meaningful attack surface.
app.use("/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Admin-Secret", "Authorization"],
  exposeHeaders: ["Content-Type"],
  credentials: false,
}));

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "Syphir API", version: "2.11.0", db: "supabase" });
});

// ── ADMIN PING ─────────────────────────────────────────────────────────────
app.get("/admin/ping", (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ ok: true });
});

// ── VALIDATE KEY ───────────────────────────────────────────────────────────
app.post("/validate-key", async (c) => {
  const { key, context, email } = await c.req.json().catch(() => ({}));
  if (!key) return c.json({ valid: false, message: "key is required" }, 400);
  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ valid: false, message: "Invalid or expired key" }, 401);
    const row = rows[0];
    const org = row.organizations;
    const keyType = row.key_type || "business";
    let daysLeft = null;
    if (row.expires_at) {
      const msLeft = new Date(row.expires_at) - new Date();
      daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      if (msLeft < 0) return c.json({ valid: false, expired: true, message: "Your trial has expired. Upgrade to continue." }, 403);
    }
    if (context === "dashboard" && keyType === "employee") {
      return c.json({ valid: false, key_type: "employee", message: "This is an employee key. Contact your admin for dashboard access." }, 403);
    }
    // Upsert employee user record so they appear in Team Members immediately
    if (email && keyType === "employee") {
      try {
        const now = new Date().toISOString();
        const existing = await db(`users?org_id=eq.${encodeURIComponent(org.id)}&email=eq.${encodeURIComponent(email)}&select=id`);
        if (existing && existing.length > 0) {
          await db(`users?id=eq.${existing[0].id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "active" }) });
        } else {
          await db("users", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ id: `user_${Date.now()}_${Math.random().toString(36).substr(2,4)}`, org_id: org.id, email, role: "member", status: "active", invited_at: now }) });
        }
        console.log(`✓ Employee registered: ${email} → org ${org.name}`);
      } catch(e) { console.warn("User upsert failed (non-fatal):", e.message); }
    }
    return c.json({ valid: true, key_type: keyType, org_id: org.id, org_name: org.name, plan: org.plan, expires_at: row.expires_at, days_left: daysLeft });
  } catch (err) {
    return c.json({ valid: false, message: "Validation failed" }, 500);
  }
});

// ── SCAN ───────────────────────────────────────────────────────────────────
app.post("/scan", async (c) => {
  const { text, key, user_email, ai_tool, url } = await c.req.json().catch(() => ({}));
  if (!key) return c.json({ valid: false, message: "key is required" }, 400);
  let org;
  try {
    // Accepts both business (SYP-) and employee (EMP-) keys — no key_type filter
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ valid: false, message: "Invalid key" }, 401);
    org = rows[0].organizations;
    if (!org || !org.id) return c.json({ valid: false, message: "Org not found" }, 401);
    console.log('scan: key type =', rows[0].key_type, 'org =', org.name);
  } catch (err) {
    return c.json({ valid: false, message: "Auth failed" }, 500);
  }
  try {
    const scanResponse = await fetch(`${SCANNER_URL}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, org_id: org.id, user_id: user_email, ai_tool }),
    });
    const result = await scanResponse.json();
    if (result.flagged) {
      const isDup = await isDuplicateIncident(org.id, user_email || "unknown", ai_tool || "AI Tool");
      if (!isDup) {
        const incident = {
          id: `inc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          org_id: org.id, org_name: org.name, user_email, ai_tool, url,
          detections: result.detections, risk_level: result.risk_level,
          message: result.message, resolved: false, timestamp: new Date().toISOString(),
        };
        await db("incidents", { method: "POST", prefer: "return=minimal", body: JSON.stringify(incident) });
      }
    }
    // Auto-register employee: upsert user record
    if (user_email && user_email !== "unknown") {
      try {
        const now = new Date().toISOString();
        const existing = await db(`users?org_id=eq.${encodeURIComponent(org.id)}&email=eq.${encodeURIComponent(user_email)}&select=id`);
        if (existing && existing.length > 0) {
          await db(`users?id=eq.${encodeURIComponent(existing[0].id)}`, {
            method: "PATCH", prefer: "return=minimal",
            body: JSON.stringify({ status: "active" }),
          });
        } else {
          await db("users", {
            method: "POST", prefer: "return=minimal",
            body: JSON.stringify({
              id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
              org_id: org.id, email: user_email,
              role: "member", status: "active",
              invited_at: now,
            }),
          });
        }
      } catch(_) {} // non-fatal — scan result must still return
    }
    return c.json({ flagged: result.flagged, risk_level: result.risk_level, message: result.message, detections: result.detections });
  } catch (err) {
    return c.json({ flagged: false, message: "Scanner unavailable" }, 500);
  }
});

// ── LOG INCIDENT DIRECTLY ──────────────────────────────────────────────────
app.post("/log-incident", async (c) => {
  const { key, user_email, ai_tool, url, risk_level, detections, message, id, timestamp } = await c.req.json().catch(() => ({}));
  if (!key) return c.json({ success: false, message: "key is required" }, 400);
  let org;
  try {
    // Accepts both business (SYP-) and employee (EMP-) keys — no key_type filter
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ success: false, message: "Invalid key" }, 401);
    org = rows[0].organizations;
    if (!org || !org.id) return c.json({ success: false, message: "Org not found" }, 401);
    console.log('log-incident: key type =', rows[0].key_type, 'org =', org.name);
  } catch (err) { return c.json({ success: false, message: "Auth failed" }, 500); }
  try {
    const normEmail = user_email || "unknown";
    const normTool = ai_tool || "AI Tool";
    const isDup = await isDuplicateIncident(org.id, normEmail, normTool);
    if (!isDup) {
      const incident = {
        id: id || `inc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        org_id: org.id, org_name: org.name,
        user_email: normEmail,
        ai_tool: normTool, url: url || "",
        detections: detections || [], risk_level: risk_level || "low",
        message: message || "PII detected", resolved: false,
        timestamp: timestamp || new Date().toISOString(),
      };
      await db("incidents", { method: "POST", prefer: "return=minimal", body: JSON.stringify(incident) });
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, message: err.message }, 500);
  }
});

// ── EMP KEY ────────────────────────────────────────────────────────────────
app.get("/emp-key/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const rows = await db(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&key_type=eq.employee&status=eq.active&select=key`);
    if (!rows || rows.length === 0) return c.json({ emp_key: null });
    return c.json({ emp_key: rows[0].key });
  } catch (err) {
    return c.json({ emp_key: null });
  }
});

// ── GET ORG BY KEY ─────────────────────────────────────────────────────────
app.get("/org/:key", async (c) => {
  const { key } = c.req.param();
  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Not found" }, 404);
    const org = rows[0].organizations;
    const keyType = rows[0].key_type;
    return c.json({ ...org, key_type: keyType });
  } catch (err) {
    return c.json({ error: "Failed" }, 500);
  }
});

// ── PATCH ORG: UPGRADE PLAN ────────────────────────────────────────────────
app.patch("/orgs/:org_id/upgrade", async (c) => {
  const { org_id } = c.req.param();
  const { plan, status, stripe_customer_id } = await c.req.json().catch(() => ({}));
  if (!org_id || !plan) return c.json({ error: "org_id and plan are required" }, 400);

  const paidPlans = ["Starter", "Professional", "Institution"];
  const isPaid = paidPlans.includes(plan);
  const expiresAt = isPaid ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const orgPatch = { plan, active: true };
    if (status) orgPatch.status = status;
    if (stripe_customer_id) orgPatch.stripe_customer_id = stripe_customer_id;

    await dbWithRetry(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(orgPatch),
    });
    await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&key_type=eq.business`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ expires_at: expiresAt, status: "active" }),
    });

    console.log(`✓ Upgraded org ${org_id} → ${plan} (expires_at: ${expiresAt || "never"})`);

    // Send upgrade confirmation email (non-fatal)
    try {
      const orgRows = await db(`organizations?id=eq.${encodeURIComponent(org_id)}&select=*`);
      const org = orgRows?.[0];
      if (org?.admin_email) {
        const keyRows = await db(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&status=eq.active&select=key,key_type`);
        const bizKey = keyRows?.find(k => k.key_type === 'business')?.key || '';
        const empKey = keyRows?.find(k => k.key_type === 'employee')?.key || '';
        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
          subject: `Welcome to Syphir ${plan} — you're protected`,
          html: buildUpgradeConfirmationHtml(org, plan, bizKey, empKey),
        });
        console.log('Email sent: upgrade-confirmation', org.name, org.admin_email);
      }
    } catch (emailErr) {
      console.warn('Upgrade confirmation email failed:', emailErr.message);
    }

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── PATCH ORG (save settings) ──────────────────────────────────────────────
app.patch("/org/:org_id", async (c) => {
  const { org_id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const allowed = {};
  if (body.name)        allowed.name        = body.name;
  if (body.admin_email) allowed.admin_email = body.admin_email;
  try {
    await db(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(allowed),
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, message: err.message }, 500);
  }
});

// ── LIST ALL ORGS (admin only) ─────────────────────────────────────────────
app.get("/admin/orgs", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  try {
    const orgs = await db("organizations?select=*&order=created_at.desc");
    const keys = await db("license_keys?status=eq.active&select=*");
    const result = (orgs || []).map(org => {
      const bizKey = (keys || []).find(k => k.org_id === org.id && k.key_type === "business");
      const empKey = (keys || []).find(k => k.org_id === org.id && k.key_type === "employee");
      return {
        ...org,
        key: bizKey?.key || null,
        emp_key: empKey?.key || null,
        expires_at: bizKey?.expires_at || null,
        key_status: bizKey?.status || null,
      };
    });
    return c.json({ orgs: result.filter(o => o.key !== null) });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── INCIDENTS ──────────────────────────────────────────────────────────────
app.get("/incidents/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const incidents = await db(`incidents?org_id=eq.${encodeURIComponent(org_id)}&order=timestamp.desc&limit=100`);
    return c.json({ incidents: incidents || [], total: incidents?.length || 0 });
  } catch (err) {
    return c.json({ incidents: [], total: 0 });
  }
});

app.get("/stats/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const incidents = await db(`incidents?org_id=eq.${encodeURIComponent(org_id)}&select=risk_level,resolved`);
    const list = incidents || [];
    const high     = list.filter(i => i.risk_level === "high").length;
    const medium   = list.filter(i => i.risk_level === "medium").length;
    const low      = list.filter(i => i.risk_level === "low").length;
    const resolved = list.filter(i => i.resolved).length;
    return c.json({ total_incidents: list.length, high_risk: high, medium_risk: medium, low_risk: low, resolved, unresolved: list.length - resolved });
  } catch (err) {
    return c.json({ total_incidents: 0, high_risk: 0, medium_risk: 0, low_risk: 0, resolved: 0, unresolved: 0 });
  }
});

app.patch("/incidents/:id/resolve", async (c) => {
  const { id } = c.req.param();
  try {
    await db(`incidents?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ resolved: true, resolved_at: new Date().toISOString() }) });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

// ── TEAM ───────────────────────────────────────────────────────────────────
app.get("/team/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const users = await db(`users?org_id=eq.${encodeURIComponent(org_id)}&order=invited_at.desc`);
    return c.json({ users: users || [] });
  } catch (err) {
    return c.json({ users: [] });
  }
});

app.patch("/team/:id/remove", async (c) => {
  const { id } = c.req.param();
  try {
    await db(`users?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "removed" }) });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

app.patch("/team/:id", async (c) => {
  const { id } = c.req.param();
  const { name, role, notes } = await c.req.json().catch(() => ({}));
  const patch = {};
  if (name  !== undefined) patch.name  = name;
  if (role  !== undefined) patch.role  = role;
  if (notes !== undefined) patch.notes = notes;
  if (!Object.keys(patch).length) return c.json({ success: true });
  try {
    await db(`users?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(patch),
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, message: err.message }, 500);
  }
});

app.post("/invite-user", async (c) => {
  const { org_key, employee_email, org_name } = await c.req.json().catch(() => ({}));
  if (!org_key || !employee_email) return c.json({ success: false, message: "org_key and employee_email are required" }, 400);
  let org;
  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(org_key)}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ success: false, message: "Invalid key" }, 401);
    org = rows[0].organizations;
  } catch (err) {
    return c.json({ success: false, message: "Auth failed" }, 500);
  }
  try {
    await db("users", { method: "POST", prefer: "return=minimal", body: JSON.stringify({ id: `user_${Date.now()}`, org_id: org.id, email: employee_email, role: "member", status: "invited", invited_at: new Date().toISOString() }) });
  } catch (err) {
    console.log("User save error:", err.message);
  }
  const installUrl = `https://syphir.vercel.app/install.html?key=${org_key}&email=${employee_email}&org=${encodeURIComponent(org_name || org.name)}`;
  const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,sans-serif;"><div style="max-width:560px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><div style="font-size:32px;">🛡️</div><div style="font-size:22px;font-weight:800;color:#fff;">Syphir</div></div><div style="background:#161b25;border:1px solid #242d3e;border-radius:12px;padding:32px;"><h1 style="color:#e6edf3;font-size:20px;font-weight:700;margin:0 0 12px;">You've been protected 🛡️</h1><p style="color:#8b949e;font-size:14px;line-height:1.6;margin:0 0 24px;"><strong style="color:#e6edf3;">${org_name || org.name}</strong> has added you to their Syphir Shield data protection system.</p><a href="${installUrl}" style="display:block;background:#5b4fe8;color:#fff;text-align:center;padding:14px 24px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;margin-bottom:16px;">Install Syphir Shield →</a><p style="color:#4a5568;font-size:11px;text-align:center;margin:0;">Only takes 60 seconds · Chrome, Edge, and Brave</p></div></div></body></html>`;
  try {
    await resend.emails.send({ from: "Syphir Shield <noreply@syphir.io>", to: employee_email, subject: `You've been added to ${org_name || org.name}'s Syphir Shield`, html: emailHtml });
    return c.json({ success: true, message: `Invite sent to ${employee_email}` });
  } catch (err) {
    return c.json({ success: false, message: "Failed to send email" }, 500);
  }
});

// ── ADMIN: CREATE ORG ──────────────────────────────────────────────────────
app.post("/admin/create-org", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  const { name, email, plan, status, key, emp_key } = await c.req.json().catch(() => ({}));
  if (!name || !key) return c.json({ error: "name and key are required" }, 400);

  // Guard: reject if biz key already exists — prevents ghost orgs on retry
  try {
    const existing = await db(`license_keys?key=eq.${encodeURIComponent(key)}&select=key`);
    if (existing && existing.length > 0) return c.json({ error: `Key already exists: ${key}` }, 409);
  } catch (_) {} // non-fatal pre-check

  let orgId = null;
  try {
    // 1. Create org — with retry
    const orgRows = await dbWithRetry("organizations", {
      method: "POST", prefer: "return=representation",
      body: JSON.stringify({ id: "org_" + Date.now(), name, plan: plan || "Demo", admin_email: email || "", active: true }),
    });
    if (!orgRows || orgRows.length === 0) return c.json({ error: "Failed to create organization" }, 500);
    const org = orgRows[0];
    orgId = org.id;

    // 2. Expiry (paying plans have no expiry)
    const isPaying = ["starter", "professional", "institution", "pro"].includes((plan || "").toLowerCase());
    const expiresAt = isPaying ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // 3. Business key — 5 retries with escalating delay
    await dbWithRetry("license_keys", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({ key, org_id: org.id, key_type: "business", status: "active", expires_at: expiresAt }),
    }, 5);

    // 4. Employee key — 5 retries
    if (emp_key) {
      await dbWithRetry("license_keys", {
        method: "POST", prefer: "return=minimal",
        body: JSON.stringify({ key: emp_key, org_id: org.id, key_type: "employee", status: "active", expires_at: expiresAt }),
      }, 5);
    }

    // 5. Poll-verify: confirm biz key is readable before declaring success (up to 10s)
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const check = await db(`license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=key`);
      if (check && check.length > 0) { verified = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!verified) {
      // Rollback: deactivate org so it doesn't appear as a ghost in the admin list
      await db(`organizations?id=eq.${encodeURIComponent(orgId)}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ active: false }) }).catch(() => {});
      return c.json({ error: "Key write could not be confirmed — org rolled back. Try again." }, 500);
    }

    console.log(`✓ New org: ${name} | id: ${org.id} | biz: ${key} | emp: ${emp_key || "none"}`);
    return c.json({ success: true, org_id: org.id, org_name: org.name, key, emp_key });
  } catch (err) {
    // Rollback: deactivate org if key writes failed
    if (orgId) {
      await db(`organizations?id=eq.${encodeURIComponent(orgId)}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ active: false }) }).catch(() => {});
    }
    return c.json({ error: "Failed to create org: " + err.message }, 500);
  }
});

// ── CONTACT SUBMISSION ────────────────────────────────────────────────────
app.post("/contact", async (c) => {
  const { name, email, company, message } = await c.req.json().catch(() => ({}));
  if (!name || !email || !message) return c.json({ error: "name, email, and message are required" }, 400);
  try {
    await db("contact_submissions", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({
        id: `sub_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        name: name.trim(), email: email.trim(),
        company: (company || "").trim(),
        message: message.trim(),
        submitted_at: new Date().toISOString(),
      }),
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: "Failed to save: " + err.message }, 500);
  }
});

// ── ADMIN: LIST CONTACT SUBMISSIONS ───────────────────────────────────────
app.get("/admin/submissions", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  try {
    const submissions = await db("contact_submissions?select=*&order=submitted_at.desc");
    return c.json({ submissions: submissions || [] });
  } catch (err) {
    return c.json({ submissions: [], error: err.message });
  }
});

// ── ADMIN: DEDUP ORGS ─────────────────────────────────────────────────────
app.post("/admin/dedup-orgs", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  try {
    const orgs = await db("organizations?select=*&order=created_at.asc");
    const keys = await db("license_keys?status=eq.active&select=*");

    const byName = {};
    for (const org of (orgs || [])) {
      const norm = org.name.toLowerCase().trim();
      if (!byName[norm]) byName[norm] = [];
      byName[norm].push(org);
    }

    const deduped = [];
    for (const group of Object.values(byName)) {
      if (group.length <= 1) continue;
      const withKey = group.filter(o => (keys || []).some(k => k.org_id === o.id && k.key_type === "business"));
      const keep = (withKey.length > 0 ? withKey : group).slice(-1)[0];
      for (const dup of group.filter(o => o.id !== keep.id)) {
        await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(dup.id)}`, {
          method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ status: "inactive" }),
        });
        deduped.push({ removed_id: dup.id, name: dup.name, kept_id: keep.id });
      }
    }
    return c.json({ success: true, count: deduped.length, deduped });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── ADMIN: UPDATE ORG ─────────────────────────────────────────────────────
app.patch("/admin/update-org", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);

  const { org_id, name, admin_email, plan, status } = await c.req.json().catch(() => ({}));
  if (!org_id) return c.json({ error: "org_id is required" }, 400);

  try {
    const paidPlans = ["Starter", "Professional", "Institution"];
    const isPaid = paidPlans.includes(plan);
    const expiresAt = isPaid ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const orgPatch = {};
    if (name)        orgPatch.name        = name;
    if (admin_email) orgPatch.admin_email = admin_email;
    if (plan)        orgPatch.plan        = plan;

    await dbWithRetry(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(orgPatch),
    });

    // Update business key: expiry driven by plan, status from form
    const keyPatch = { expires_at: expiresAt };
    if (status) keyPatch.status = status === "inactive" ? "inactive" : "active";

    await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&key_type=eq.business`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(keyPatch),
    });

    console.log(`✓ Updated org ${org_id}: plan=${plan}, status=${status}, paid=${isPaid}`);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── ADMIN: REMOVE ORG ──────────────────────────────────────────────────────
app.delete("/admin/remove-org/:key", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  const { key } = c.req.param();
  try {
    // Look up org_id (check all key statuses so already-inactive keys still resolve)
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&select=org_id`);
    if (!rows || rows.length === 0) return c.json({ success: true, note: "Key not found" });
    const orgId = rows[0].org_id;

    // Hard-delete all license keys for this org, then the org itself
    await db(`license_keys?org_id=eq.${encodeURIComponent(orgId)}`, { method: "DELETE", prefer: "return=minimal" });
    await db(`organizations?id=eq.${encodeURIComponent(orgId)}`, { method: "DELETE", prefer: "return=minimal" });

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: "Failed: " + err.message }, 500);
  }
});

// ── STRIPE: CREATE CHECKOUT SESSION ───────────────────────────────────────
app.post("/create-checkout-session", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const { plan } = body;
  if (!plan) return c.json({ error: "plan is required" }, 400);

  const price = STRIPE_PLANS[plan];
  if (!price) return c.json({ error: `Unknown plan: ${plan}` }, 400);

  try {
    let org, key, isNewCustomer = false;

    if (body.key) {
      // Existing customer upgrading
      const rows = await db(`license_keys?key=eq.${encodeURIComponent(body.key)}&status=eq.active&select=*,organizations(*)`);
      if (!rows || rows.length === 0) return c.json({ error: "Invalid or inactive key" }, 401);
      org = rows[0].organizations;
      key = body.key;
    } else if (body.email) {
      // New customer — create org + keys upfront
      isNewCustomer = true;
      const email = body.email.toLowerCase().trim();
      const orgName = body.orgName || email.split("@")[0];
      const orgId = `org_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      key = genKey();
      const empKey = genEmpKey();
      const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

      await dbWithRetry("organizations", {
        method: "POST", prefer: "return=minimal",
        body: JSON.stringify({ id: orgId, name: orgName, admin_email: email, plan: "trial", active: true }),
      });
      // Business key
      await dbWithRetry("license_keys", {
        method: "POST", prefer: "return=minimal",
        body: JSON.stringify({ key, org_id: orgId, key_type: "business", status: "active", expires_at: trialEnd }),
      });
      // Employee key (separate row, key_type=employee)
      await dbWithRetry("license_keys", {
        method: "POST", prefer: "return=minimal",
        body: JSON.stringify({ key: empKey, org_id: orgId, key_type: "employee", status: "active", expires_at: trialEnd }),
      });
      org = { id: orgId, name: orgName, admin_email: email };
    } else {
      return c.json({ error: "key or email is required" }, 400);
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: price.label, description: `Syphir AI Data Protection for ${org.name}` },
          unit_amount: price.amount,
          recurring: { interval: "month" },
        },
        quantity: 1,
      }],
      metadata: { org_id: org.id, org_name: org.name, key, plan, is_new_customer: isNewCustomer ? "true" : "false" },
      customer_email: org.admin_email || undefined,
      success_url: isNewCustomer
        ? `https://syphir.vercel.app/success.html`
        : `https://syphir.vercel.app/app.html?key=${key}&payment=success`,
      cancel_url: `https://syphir.vercel.app/pricing.html`,
    });

    return c.json({ url: session.url });
  } catch (err) {
    return c.json({ error: "Stripe error: " + err.message }, 500);
  }
});

// ── STRIPE: WEBHOOK ────────────────────────────────────────────────────────
app.post("/stripe-webhook", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const sig = c.req.header("stripe-signature");
  const rawBody = await c.req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return c.text("Webhook signature invalid", 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { org_id, plan, key, is_new_customer } = session.metadata || {};
    if (org_id && plan) {
      try {
        await dbWithRetry(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
          method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ plan, active: true, stripe_customer_id: session.customer || null }),
        });
        await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(org_id)}`, {
          method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ expires_at: null, status: "active" }),
        });
        console.log(`✓ Payment success: org ${org_id} → plan ${plan}, customer ${session.customer}`);

        if (is_new_customer === "true" && session.customer_details?.email && key) {
          const email = session.customer_details.email;
          const dashboardUrl = `https://syphir.vercel.app/app.html?key=${key}`;
          await resend.emails.send({
            from: "Syphir Shield <noreply@syphir.io>",
            to: email,
            subject: "Welcome to Syphir — your dashboard is ready",
            html: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a2e;">
                <div style="font-size:24px;font-weight:700;margin-bottom:8px;">You're protected. 🛡️</div>
                <p style="color:#555;margin-bottom:24px;">Your Syphir ${plan} subscription is active. Here's your dashboard access:</p>
                <div style="background:#f4f4f8;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
                  <div style="font-size:12px;color:#888;margin-bottom:4px;">YOUR DASHBOARD KEY</div>
                  <code style="font-size:18px;font-weight:700;color:#1a1a2e;letter-spacing:1px;">${key}</code>
                </div>
                <a href="${dashboardUrl}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-bottom:24px;">Open Dashboard →</a>
                <p style="color:#888;font-size:13px;">Save this key — you'll need it every time you sign in. If you have any questions, reply to this email.</p>
              </div>
            `,
          });
          console.log(`✓ Welcome email sent to ${email} with key ${key}`);
        }
      } catch (err) {
        console.error("Failed to update org post-payment:", err.message);
      }
    }
  }

  return c.json({ received: true });
});

// ── STRIPE: CUSTOMER PORTAL ────────────────────────────────────────────────
app.post("/create-portal-session", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const { key } = await c.req.json().catch(() => ({}));
  if (!key) return c.json({ error: "key is required" }, 400);

  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Invalid key" }, 401);
    const org = rows[0].organizations;

    if (!org.stripe_customer_id) {
      return c.json({ error: "No active subscription found for this account" }, 404);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `https://syphir.vercel.app/app.html?key=${key}`,
    });

    return c.json({ url: session.url });
  } catch (err) {
    return c.json({ error: "Stripe error: " + err.message }, 500);
  }
});

// ── BILLING: GET invoice history ───────────────────────────────────────────
// Must be registered BEFORE /billing/:key to prevent "invoices" matching as key param
app.get("/billing/invoices/:key", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const key = c.req.param("key");
  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Invalid key" }, 401);
    const org = rows[0].organizations;
    if (!org.stripe_customer_id) return c.json({ invoices: [] });

    const invoices = await stripe.invoices.list({ customer: org.stripe_customer_id, limit: 24 });
    return c.json({
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        date: inv.created,
        amount: inv.amount_paid,
        currency: inv.currency,
        status: inv.status,
        pdf: inv.invoice_pdf,
        number: inv.number,
      })),
    });
  } catch (err) {
    return c.json({ error: "Stripe error: " + err.message }, 500);
  }
});

// ── BILLING: GET subscription + payment method ────────────────────────────
app.get("/billing/:key", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const key = c.req.param("key");
  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Invalid key" }, 401);
    const org = rows[0].organizations;
    if (!org.stripe_customer_id) return c.json({ error: "No billing account found" }, 404);

    const [customer, subscriptions] = await Promise.all([
      stripe.customers.retrieve(org.stripe_customer_id),
      stripe.subscriptions.list({ customer: org.stripe_customer_id, limit: 1, status: "all" }),
    ]);

    const sub = subscriptions.data[0] || null;
    let paymentMethod = null;
    if (sub?.default_payment_method) {
      paymentMethod = await stripe.paymentMethods.retrieve(sub.default_payment_method);
    } else if (customer.invoice_settings?.default_payment_method) {
      paymentMethod = await stripe.paymentMethods.retrieve(customer.invoice_settings.default_payment_method);
    }

    return c.json({
      org_id: org.id,
      org_name: org.name,
      plan: org.plan,
      stripe_customer_id: org.stripe_customer_id,
      subscription: sub ? {
        id: sub.id,
        status: sub.status,
        plan_name: sub.items?.data[0]?.price?.nickname || org.plan,
        amount: sub.items?.data[0]?.price?.unit_amount || 0,
        currency: sub.items?.data[0]?.price?.currency || "usd",
        interval: sub.items?.data[0]?.price?.recurring?.interval || "month",
        current_period_end: sub.current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end,
      } : null,
      payment_method: paymentMethod ? {
        brand: paymentMethod.card?.brand || "card",
        last4: paymentMethod.card?.last4 || "????",
        exp_month: paymentMethod.card?.exp_month,
        exp_year: paymentMethod.card?.exp_year,
      } : null,
    });
  } catch (err) {
    return c.json({ error: "Stripe error: " + err.message }, 500);
  }
});

// ── BILLING: CANCEL subscription ───────────────────────────────────────────
app.delete("/billing/cancel", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const { key } = await c.req.json().catch(() => ({}));
  if (!key) return c.json({ error: "key is required" }, 400);
  try {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Invalid key" }, 401);
    const org = rows[0].organizations;
    if (!org.stripe_customer_id) return c.json({ error: "No billing account found" }, 404);

    const subscriptions = await stripe.subscriptions.list({ customer: org.stripe_customer_id, status: "active", limit: 1 });
    if (subscriptions.data.length === 0) return c.json({ error: "No active subscription found" }, 404);

    // Cancel at period end (not immediately)
    await stripe.subscriptions.update(subscriptions.data[0].id, { cancel_at_period_end: true });

    // Downgrade org to trial in Supabase
    await dbWithRetry(`organizations?id=eq.${encodeURIComponent(org.id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ plan: "trial" }),
    });

    console.log(`✓ Cancelled subscription for org ${org.id}`);
    return c.json({ success: true, message: "Subscription will cancel at end of billing period" });
  } catch (err) {
    return c.json({ error: "Stripe error: " + err.message }, 500);
  }
});

// ── WEEKLY REPORTS ─────────────────────────────────────────────────────────
app.post("/admin/send-weekly-reports", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const targetOrgId = body.org_id || null;

  const now      = new Date();
  const weekAgo  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekStart = weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const weekEnd   = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const dateLabel = now.toISOString().slice(0, 10);

  let orgs;
  try {
    orgs = targetOrgId
      ? await db(`organizations?id=eq.${encodeURIComponent(targetOrgId)}&select=*`)
      : await db('organizations?active=eq.true&select=*');
  } catch (err) {
    return c.json({ error: 'Failed to load orgs: ' + err.message }, 500);
  }
  if (!orgs || orgs.length === 0) return c.json({ sent: 0, skipped: 0 });

  const results = [];
  for (const org of orgs) {
    if (!org.admin_email) { results.push({ org: org.name, skipped: 'no email' }); continue; }
    try {
      const incidents = await db(
        `incidents?org_id=eq.${encodeURIComponent(org.id)}&timestamp=gte.${encodeURIComponent(weekAgo.toISOString())}&order=timestamp.desc`
      ).catch(() => []) || [];

      const keyRows = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
      ).catch(() => []) || [];
      const orgKey = keyRows[0]?.key || '';

      if (incidents.length === 0) {
        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
          subject: `Your Syphir weekly report — quiet week at ${org.name}`,
          html: buildQuietWeekHtml(org, weekStart, weekEnd, orgKey),
        });
      } else {
        const csvContent = buildIncidentCsv(incidents);
        const fileName   = `syphir-report-${org.name.toLowerCase().replace(/[^a-z0-9]/g,'-')}-${dateLabel}.csv`;
        const total = incidents.length;
        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
          subject: `Syphir weekly report — ${total} incident${total!==1?'s':''} at ${org.name}`,
          html: buildWeeklyReportHtml(org, incidents, orgKey, weekStart, weekEnd),
          attachments: [{ filename: fileName, content: Buffer.from(csvContent).toString('base64') }],
        });
      }
      console.log('Email sent: weekly-report', org.name, org.admin_email);
      results.push({ org: org.name, incidents: incidents.length, sent: true });
    } catch (err) {
      console.error('Weekly report failed for', org.name, ':', err.message);
      results.push({ org: org.name, error: err.message });
    }
  }
  return c.json({ sent: results.filter(r=>r.sent).length, total: orgs.length, results });
});

// ── EXPIRY WARNINGS (3 days before) ────────────────────────────────────────
app.post("/admin/send-expiry-warnings", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);

  const now     = new Date();
  const in3days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  let orgs;
  try {
    orgs = await db(
      `organizations?expires_at=gte.${encodeURIComponent(now.toISOString())}&expires_at=lte.${encodeURIComponent(in3days.toISOString())}&or=(expiry_warning_sent.is.null,expiry_warning_sent.is.false)&select=*`
    );
  } catch (err) {
    return c.json({ error: 'Failed to query orgs: ' + err.message }, 500);
  }
  if (!orgs || orgs.length === 0) return c.json({ sent: 0, message: 'No orgs expiring in 3 days' });

  const results = [];
  for (const org of orgs) {
    if (!org.admin_email) { results.push({ org: org.name, skipped: 'no email' }); continue; }
    try {
      const incidents = await db(
        `incidents?org_id=eq.${encodeURIComponent(org.id)}&order=timestamp.desc`
      ).catch(() => []) || [];

      const total      = incidents.length;
      const highRisk   = incidents.find(i => i.risk_level === 'high') || incidents[0];
      const expiryDate = new Date(org.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      let proofLine = '';
      if (highRisk) {
        const detType = Array.isArray(highRisk.detections) && highRisk.detections[0]
          ? (highRisk.detections[0].type || highRisk.detections[0].label || 'PII') : 'PII';
        proofLine = `Your most critical detection: <strong>${detType}</strong> in ${highRisk.ai_tool || 'an AI tool'} by ${highRisk.user_email || 'a team member'}.`;
      }

      await resend.emails.send({
        from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
        subject: `Your Syphir trial ends in 3 days — ${org.name}`,
        html: buildExpiryWarningHtml(org, expiryDate, total, proofLine),
      });

      try {
        await db(`organizations?id=eq.${encodeURIComponent(org.id)}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ expiry_warning_sent: true }),
        });
      } catch(_) {}

      console.log('Email sent: expiry-warning', org.name, org.admin_email);
      results.push({ org: org.name, sent: true });
    } catch (err) {
      console.error('Expiry warning failed for', org.name, ':', err.message);
      results.push({ org: org.name, error: err.message });
    }
  }
  return c.json({ sent: results.filter(r=>r.sent).length, total: orgs.length, results });
});

// ── EXPIRY NOTICES (after expiry) ───────────────────────────────────────────
app.post("/admin/send-expiry-notices", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);

  const now = new Date();

  let orgs;
  try {
    orgs = await db(
      `organizations?expires_at=lt.${encodeURIComponent(now.toISOString())}&or=(expiry_notice_sent.is.null,expiry_notice_sent.is.false)&select=*`
    );
  } catch (err) {
    return c.json({ error: 'Failed to query orgs: ' + err.message }, 500);
  }
  if (!orgs || orgs.length === 0) return c.json({ sent: 0, message: 'No expired orgs found' });

  const results = [];
  for (const org of orgs) {
    if (!org.admin_email) { results.push({ org: org.name, skipped: 'no email' }); continue; }
    try {
      const incidents = await db(
        `incidents?org_id=eq.${encodeURIComponent(org.id)}&order=timestamp.desc`
      ).catch(() => []) || [];

      const total      = incidents.length;
      const expiryDate = org.expires_at
        ? new Date(org.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'recently';

      await resend.emails.send({
        from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
        subject: `Your Syphir protection has paused — ${org.name}`,
        html: buildExpiryNoticeHtml(org, expiryDate, total),
      });

      try {
        await db(`organizations?id=eq.${encodeURIComponent(org.id)}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ expiry_notice_sent: true }),
        });
      } catch(_) {}

      console.log('Email sent: expiry-notice', org.name, org.admin_email);
      results.push({ org: org.name, sent: true });
    } catch (err) {
      console.error('Expiry notice failed for', org.name, ':', err.message);
      results.push({ org: org.name, error: err.message });
    }
  }
  return c.json({ sent: results.filter(r=>r.sent).length, total: orgs.length, results });
});

console.log("Syphir API v2.11.0 running");
// Keep Render awake — ping every 10 minutes
setInterval(() => fetch("https://syphir-api.onrender.com/health").catch(() => {}), 10 * 60 * 1000);
export default { port: 3000, fetch: app.fetch };
