// CRON: POST /admin/send-weekly-reports   — every Monday    8:00 AM PST  (X-Admin-Secret: [ADMIN_SECRET])
// CRON: POST /admin/send-expiry-warnings  — every day       9:00 AM PST  (X-Admin-Secret: [ADMIN_SECRET])
// CRON: POST /admin/send-expiry-notices   — every day       9:05 AM PST  (X-Admin-Secret: [ADMIN_SECRET])

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Resend } from "resend";
import Stripe from "stripe";
import PDFDocument from "pdfkit";

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
  <div style="text-align:center;padding:28px 32px 20px;border-bottom:1px solid #1e2636;margin-bottom:24px;">
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:8px;">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="#2DD4BF"><path d="M8 1L2 4v5c0 3.5 2.5 6 6 7 3.5-1 6-3.5 6-7V4L8 1z"/></svg>
      <span style="font-size:20px;font-weight:800;color:#e6edf3;">Syphir</span>
    </div>
    <div style="color:#8b949e;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px;">AI Data Protection</div>
    <div style="display:inline-block;background:#1c2333;border:1px solid #2DD4BF;border-radius:4px;padding:3px 10px;color:#2DD4BF;font-size:10px;letter-spacing:0.1em;font-weight:700;text-transform:uppercase;margin-bottom:6px;">Weekly Report</div>
    <div style="color:#8b949e;font-size:12px;">${weekStart} &mdash; ${weekEnd}</div>
  </div>
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

// ── SHORT WEEKLY EMAIL (body only — detail lives in PDF) ───────────────────
function buildShortWeeklyHtml(org, incidents, orgKey, periodLabel) {
  const total = incidents.length;
  const high  = incidents.filter(i => i.risk_level === 'high').length;
  const dashUrl = `https://syphir.vercel.app/app.html?key=${orgKey}`;
  const summary = high > 3
    ? `Syphir caught ${total} incidents at ${org.name}, including ${high} high-risk detections. Immediate review recommended.`
    : total > 5
      ? `Your team had ${total} incidents this week. ${high} were high-risk.`
      : `${total} incident${total !== 1 ? 's' : ''} detected this week, mostly low-risk.`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
  ${emailHeader('Weekly Report', periodLabel)}
  <div style="font-size:22px;font-weight:800;color:#e6edf3;margin-bottom:8px;">${org.name}</div>
  <p style="font-size:14px;color:#8b949e;line-height:1.6;margin:0 0 12px;">${summary}</p>
  <p style="font-size:13px;color:#8b949e;margin:0 0 28px;">&#128206; Full incident report attached as PDF &amp; CSV.</p>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${dashUrl}" style="display:inline-block;background:#2DD4BF;color:#0d1117;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">View Dashboard &#8594;</a>
  </div>
  ${emailFooter(org.name)}
</div></body></html>`;
}

// ── PDF REPORT GENERATOR ────────────────────────────────────────────────────
async function generateWeeklyPdf(org, incidents, periodLabel, dateLabel) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PW = 595.28, PH = 841.89, M = 50;
      const C = {
        bg: '#0d1117', surface: '#161b25', border: '#1e2636',
        accent: '#2DD4BF', text: '#e6edf3', muted: '#8b949e',
        red: '#ef4444', amber: '#f59e0b', green: '#22c55e',
      };

      function bg() { doc.rect(0, 0, PW, PH).fill(C.bg); }
      function hRule(y) {
        doc.strokeColor(C.border).lineWidth(0.5).moveTo(M, y).lineTo(PW - M, y).stroke();
      }
      function maybeNewPage(y) {
        if (y > PH - 110) {
          doc.addPage(); bg(); return M;
        }
        return y;
      }

      bg();

      // ── HEADER ──
      doc.fontSize(20).font('Helvetica-Bold').fillColor(C.text).text('Syphir', M, M, { lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(C.muted)
         .text(`Weekly Report  ·  ${periodLabel}`, M, M + 6, { align: 'right', width: PW - M * 2, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(C.muted).text('AI Data Protection', M, M + 26);
      let y = M + 58;
      hRule(y); y += 18;

      // ── ORG + SUMMARY ──
      const total    = incidents.length;
      const high     = incidents.filter(i => i.risk_level === 'high').length;
      const low      = incidents.filter(i => i.risk_level === 'low').length;
      const resolved = incidents.filter(i => i.resolved).length;
      const summary  = high > 3
        ? `This week Syphir caught ${total} incidents — including ${high} high-risk detections. Immediate review recommended.`
        : total > 5
          ? `${total} incidents detected. ${high} were high-risk and warrant a closer look.`
          : `A quiet week — ${total} incident${total !== 1 ? 's' : ''} detected, mostly low-risk.`;

      doc.fontSize(15).font('Helvetica-Bold').fillColor(C.text).text(org.name, M, y); y = doc.y + 5;
      doc.fontSize(10).font('Helvetica').fillColor(C.muted).text(summary, M, y, { width: PW - M * 2 }); y = doc.y + 16;

      // ── STAT CARDS ──
      const cardW = (PW - M * 2 - 12) / 4, cardH = 58;
      const stats = [
        { label: 'TOTAL', val: String(total),    color: C.text  },
        { label: 'HIGH RISK',   val: String(high),     color: C.red   },
        { label: 'LOW RISK',    val: String(low),      color: C.amber },
        { label: 'RESOLVED',    val: String(resolved), color: C.green },
      ];
      stats.forEach((s, i) => {
        const x = M + i * (cardW + 4);
        doc.roundedRect(x, y, cardW, cardH, 3).fillAndStroke(C.surface, C.border);
        doc.fontSize(22).font('Helvetica-Bold').fillColor(s.color)
           .text(s.val, x, y + 7, { width: cardW, align: 'center', lineBreak: false });
        doc.fontSize(7).font('Helvetica').fillColor(C.muted)
           .text(s.label, x, y + 38, { width: cardW, align: 'center', lineBreak: false });
      });
      y += cardH + 18;

      // ── INCIDENTS BY DAY ──
      const byDay = {};
      incidents.forEach(i => {
        const d = i.timestamp ? i.timestamp.slice(0, 10) : 'Unknown';
        byDay[d] = (byDay[d] || 0) + 1;
      });
      const dayEntries = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
      if (dayEntries.length > 0) {
        y = maybeNewPage(y);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(C.accent).text('INCIDENTS BY DAY', M, y); y += 13;
        dayEntries.forEach(([date, count]) => {
          doc.fontSize(9).font('Helvetica').fillColor(C.muted).text(`${date}`, M, y, { continued: true, width: 100 });
          doc.fillColor(C.text).font('Helvetica-Bold').text(`  ${count}`, { continued: false });
          y += 13;
        });
        y += 10;
      }

      // ── TOP DETECTIONS TABLE ──
      const top10 = incidents.slice(0, 10);
      if (top10.length > 0) {
        y = maybeNewPage(y);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(C.accent).text('TOP DETECTIONS', M, y); y += 13;
        // Header
        doc.rect(M, y, PW - M * 2, 16).fill(C.surface);
        const cols = [
          { label: 'USER',      x: M + 4,   w: 130 },
          { label: 'AI TOOL',   x: M + 138, w: 80  },
          { label: 'RISK',      x: M + 222, w: 38  },
          { label: 'DETECTION', x: M + 264, w: 120 },
          { label: 'DATE',      x: M + 388, w: 70  },
        ];
        cols.forEach(col => {
          doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.muted)
             .text(col.label, col.x, y + 4, { width: col.w, lineBreak: false });
        });
        y += 16;
        top10.forEach((inc, idx) => {
          y = maybeNewPage(y);
          if (idx % 2 === 0) doc.rect(M, y, PW - M * 2, 15).fill(C.surface);
          const dets = Array.isArray(inc.detections)
            ? inc.detections.map(d => (d.type || d.label || '')).filter(Boolean).join(', ').slice(0, 28)
            : '—';
          const rColor = inc.risk_level === 'high' ? C.red : inc.risk_level === 'medium' ? C.amber : C.muted;
          doc.fontSize(7.5).font('Helvetica').fillColor(C.text)
             .text((inc.user_email || '—').slice(0, 22), cols[0].x, y + 3, { width: cols[0].w, lineBreak: false });
          doc.fillColor(C.muted)
             .text((inc.ai_tool || '—').slice(0, 14), cols[1].x, y + 3, { width: cols[1].w, lineBreak: false });
          doc.fillColor(rColor).font('Helvetica-Bold')
             .text((inc.risk_level || '—').toUpperCase().slice(0, 6), cols[2].x, y + 3, { width: cols[2].w, lineBreak: false });
          doc.fillColor(C.muted).font('Helvetica')
             .text(dets, cols[3].x, y + 3, { width: cols[3].w, lineBreak: false });
          doc.fillColor(C.muted)
             .text(inc.timestamp ? inc.timestamp.slice(0, 10) : '—', cols[4].x, y + 3, { width: cols[4].w, lineBreak: false });
          y += 15;
        });
        y += 10;
      }

      // ── AI TOOLS ──
      const byTool = {};
      incidents.forEach(i => { const t = i.ai_tool || 'Unknown'; byTool[t] = (byTool[t] || 0) + 1; });
      const toolEntries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
      if (toolEntries.length > 0) {
        y = maybeNewPage(y);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(C.accent).text('AI TOOLS USED', M, y); y += 13;
        toolEntries.forEach(([tool, count]) => {
          doc.fontSize(9).font('Helvetica').fillColor(C.text)
             .text(`${tool}  —  ${count} detection${count !== 1 ? 's' : ''}`, M, y); y += 13;
        });
        y += 8;
      }

      // ── DETECTION TYPES ──
      const byType = {};
      incidents.forEach(i => {
        if (Array.isArray(i.detections)) {
          i.detections.forEach(d => { const t = d.type || d.label || 'Unknown'; byType[t] = (byType[t] || 0) + 1; });
        }
      });
      const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
      if (typeEntries.length > 0) {
        y = maybeNewPage(y);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(C.accent).text('DETECTION TYPES', M, y); y += 13;
        typeEntries.forEach(([type, count]) => {
          doc.fontSize(9).font('Helvetica').fillColor(C.text)
             .text(`${type.replace(/_/g, ' ')}  —  ${count}`, M, y); y += 13;
        });
        y += 8;
      }

      // ── FOOTER ──
      const footerY = PH - 44;
      hRule(footerY);
      doc.fontSize(7.5).font('Helvetica').fillColor(C.muted)
         .text('Syphir AI Data Protection  ·  syphir.vercel.app  ·  syphir26@gmail.com',
               M, footerY + 8, { align: 'center', width: PW - M * 2, lineBreak: false });
      doc.text(`Generated ${new Date().toLocaleDateString()}  ·  Confidential`,
               M, footerY + 20, { align: 'center', width: PW - M * 2, lineBreak: false });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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

// ── RATE LIMITING ──────────────────────────────────────────────────────────
// Lightweight in-memory limiter. Tracks requests per IP per bucket in a plain
// Map and prunes expired entries. No external service needed. Returns true when
// the request should be blocked (caller responds 429). Real users never hit the
// caps; this just stops brute-force and spam.
const _rlStore = new Map();
function isRateLimited(c, bucket, max, windowMs) {
  const ip =
    (c.req.header("x-forwarded-for") || "").split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "unknown";
  const now = Date.now();
  const mapKey = `${bucket}:${ip}`;
  let entry = _rlStore.get(mapKey);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + windowMs };
    _rlStore.set(mapKey, entry);
  }
  entry.count++;
  // Opportunistic cleanup so the Map doesn't grow unbounded
  if (_rlStore.size > 5000) {
    for (const [k, v] of _rlStore) { if (now > v.reset) _rlStore.delete(k); }
  }
  return entry.count > max;
}

// ── ADMIN AUTH ─────────────────────────────────────────────────────────────
// Single source of truth for admin checks. Fails closed: if ADMIN_SECRET is
// unset (empty), NO request is authorized — even one sending an empty header.
function requireAdmin(c) {
  if (!ADMIN_SECRET) return false;                       // env not configured → deny all
  const provided = c.req.header("X-Admin-Secret");
  return !!provided && provided === ADMIN_SECRET;
}

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "Syphir API", version: "2.11.0", db: "supabase" });
});

// ── ADMIN PING ─────────────────────────────────────────────────────────────
app.get("/admin/ping", (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ ok: true });
});

// ── VALIDATE KEY ───────────────────────────────────────────────────────────
app.post("/validate-key", async (c) => {
  if (isRateLimited(c, "validate-key", 30, 60_000)) return c.json({ valid: false, message: "Too many attempts. Slow down." }, 429);
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
  if (isRateLimited(c, "scan", 120, 60_000)) return c.json({ valid: false, message: "Rate limit exceeded." }, 429);
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
  const key = c.req.query("key");
  if (!(await keyOwnsOrg(key, org_id))) return c.json({ error: "Unauthorized" }, 401);
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

// ── PATCH ORG: UPGRADE PLAN / RESET TRIAL ─────────────────────────────────
app.patch("/orgs/:org_id/upgrade", async (c) => {
  const { org_id } = c.req.param();
  const { plan, status, stripe_customer_id, reset_trial } = await c.req.json().catch(() => ({}));

  // reset_trial: reactivate all keys for 7 more days, keep existing plan
  let resolvedPlan = plan;
  let expiresAt;

  if (reset_trial) {
    expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    if (!resolvedPlan) {
      // Fetch current plan from DB so we don't overwrite it
      const cur = await db(`organizations?id=eq.${encodeURIComponent(org_id)}&select=plan`).catch(() => []);
      resolvedPlan = cur?.[0]?.plan || "Demo";
    }
  } else {
    if (!org_id || !resolvedPlan) return c.json({ error: "org_id and plan are required" }, 400);
    const paidPlans = ["Starter", "Professional", "Institution"];
    const isPaid = paidPlans.includes(resolvedPlan);
    expiresAt = isPaid ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  try {
    const orgPatch = { plan: resolvedPlan, active: true };
    if (status) orgPatch.status = status;
    if (stripe_customer_id) orgPatch.stripe_customer_id = stripe_customer_id;

    await dbWithRetry(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify(orgPatch),
    });
    // Update ALL license keys for the org (business + employee)
    await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ expires_at: expiresAt, status: "active" }),
    });

    console.log(`✓ ${reset_trial ? "Trial reset" : "Upgraded"} org ${org_id} → ${resolvedPlan} (expires_at: ${expiresAt || "never"})`);
    console.log("License keys reset for org:", org_id);

    // Send upgrade confirmation email — skip for trial resets (not a new signup)
    if (!reset_trial) {
      try {
        const orgRows = await db(`organizations?id=eq.${encodeURIComponent(org_id)}&select=*`);
        const org = orgRows?.[0];
        if (org?.admin_email) {
          const keyRows = await db(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&status=eq.active&select=key,key_type`);
          const bizKey = keyRows?.find(k => k.key_type === 'business')?.key || '';
          const empKey = keyRows?.find(k => k.key_type === 'employee')?.key || '';
          await resend.emails.send({
            from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
            subject: `Welcome to Syphir ${resolvedPlan} — you're protected`,
            html: buildUpgradeConfirmationHtml(org, resolvedPlan, bizKey, empKey),
          });
          console.log('Email sent: upgrade-confirmation', org.name, org.admin_email);
        }
      } catch (emailErr) {
        console.warn('Upgrade confirmation email failed:', emailErr.message);
      }
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
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
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

// ── Verify a license key actually belongs to the requested org_id.
// Returns true only if the key is active and maps to that org. This stops
// anyone from reading another org's data by guessing its org_id.
async function keyOwnsOrg(key, orgId) {
  if (!key || !orgId) return false;
  try {
    const rows = await db(
      `license_keys?key=eq.${encodeURIComponent(key)}&status=eq.active&select=org_id`
    );
    return !!(rows && rows.length && rows[0].org_id === orgId);
  } catch (_) {
    return false;
  }
}

app.get("/incidents/:org_id", async (c) => {
  const { org_id } = c.req.param();
  const key = c.req.query("key");
  if (!(await keyOwnsOrg(key, org_id))) return c.json({ error: "Unauthorized" }, 401);
  try {
    const incidents = await db(`incidents?org_id=eq.${encodeURIComponent(org_id)}&order=timestamp.desc&limit=100`);
    return c.json({ incidents: incidents || [], total: incidents?.length || 0 });
  } catch (err) {
    return c.json({ incidents: [], total: 0 });
  }
});

app.get("/stats/:org_id", async (c) => {
  const { org_id } = c.req.param();
  const key = c.req.query("key");
  if (!(await keyOwnsOrg(key, org_id))) return c.json({ error: "Unauthorized" }, 401);
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
  const key = c.req.query("key");
  if (!(await keyOwnsOrg(key, org_id))) return c.json({ error: "Unauthorized" }, 401);
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
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
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
  if (isRateLimited(c, "contact", 5, 60_000)) return c.json({ error: "Too many messages. Try again shortly." }, 429);
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

// ── NODE WAITLIST: public signup ──────────────────────────────────────────
app.post("/node-waitlist", async (c) => {
  if (isRateLimited(c, "node-waitlist", 5, 60_000)) return c.json({ error: "Too many attempts. Try again shortly." }, 429);
  const { email } = await c.req.json().catch(() => ({}));
  const userEmail = (email || "").trim().toLowerCase();
  if (!userEmail || !userEmail.includes("@")) return c.json({ error: "Valid email required" }, 400);
  try {
    // Dedupe — if they're already on the list, just say success
    const existing = await db(
      `node_waitlist?email=eq.${encodeURIComponent(userEmail)}&select=id`
    ).catch(() => []);
    if (existing?.length) return c.json({ success: true, already: true });

    await db("node_waitlist", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({
        id: `wl_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        email: userEmail,
        created_at: new Date().toISOString(),
      }),
    });
    console.log(`[Waitlist] Node waitlist signup: ${userEmail}`);
    return c.json({ success: true });
  } catch (err) {
    console.error("[Waitlist] error:", err.message);
    return c.json({ error: "Failed to join waitlist: " + err.message }, 500);
  }
});

// ── ADMIN: LIST NODE WAITLIST ─────────────────────────────────────────────
app.get("/admin/node-waitlist", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const entries = await db("node_waitlist?select=*&order=created_at.desc");
    return c.json({ waitlist: entries || [] });
  } catch (err) {
    return c.json({ waitlist: [], error: err.message });
  }
});

// ── ADMIN: LIST CONTACT SUBMISSIONS ───────────────────────────────────────
app.get("/admin/submissions", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const submissions = await db("contact_submissions?select=*&order=submitted_at.desc");
    return c.json({ submissions: submissions || [] });
  } catch (err) {
    return c.json({ submissions: [], error: err.message });
  }
});

// ── ADMIN: LIST PENDING SELF-SERVE SIGNUPS ────────────────────────────────
app.get("/admin/pending-signups", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const orgs = await db("organizations?signup_status=eq.pending&select=*&order=created_at.desc");
    return c.json({ signups: orgs || [] });
  } catch (err) {
    return c.json({ signups: [], error: err.message });
  }
});

// ── ADMIN: APPROVE A PENDING SIGNUP — activates the 7-day trial ──────────
app.post("/admin/approve-signup", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  const { org_id } = await c.req.json().catch(() => ({}));
  if (!org_id) return c.json({ error: "org_id required" }, 400);

  try {
    const orgs = await db(`organizations?id=eq.${encodeURIComponent(org_id)}&select=*`).catch(() => []);
    const org = orgs?.[0];
    if (!org) return c.json({ error: "Org not found" }, 404);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await db(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ active: true, signup_status: "approved", expires_at: expiresAt }),
    });

    const keys = await db(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&select=*`).catch(() => []);
    for (const k of (keys || [])) {
      await db(`license_keys?id=eq.${encodeURIComponent(k.id)}`, {
        method: "PATCH", prefer: "return=minimal",
        body: JSON.stringify({ status: "active", expires_at: expiresAt }),
      }).catch(() => {});
    }
    const bizKey = keys?.find(k => k.key_type === "business")?.key;

    // Welcome email — this is the one that actually unlocks them.
    if (bizKey) {
      try {
        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
          subject: `You're approved — welcome to Syphir 🛡️`,
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0d1117;color:#e6edf3;">
              <div style="font-size:22px;font-weight:700;margin-bottom:8px;">Your trial has begun. 🛡️</div>
              <p style="color:#8b949e;margin-bottom:24px;line-height:1.6;">You're approved and your Syphir trial is active for the next 7 days. Log in to access your dashboard and start reviewing your logs.</p>
              <a href="https://syphir.vercel.app/dashboard/app.html?key=${bizKey}&org=${encodeURIComponent(org.name)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-bottom:24px;">Log in to your dashboard →</a>
              <div style="background:#161b22;border:1px solid #1e2636;border-radius:10px;padding:20px;margin-bottom:20px;">
                <div style="font-size:11px;color:#4a5568;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">DASHBOARD KEY</div>
                <div style="font-size:20px;font-weight:700;font-family:'Courier New',monospace;color:#4db8f0;letter-spacing:1px;">${bizKey}</div>
                <div style="font-size:11px;color:#4a5568;margin-top:8px;">Keep this safe — it's your login. Or just sign in with this email at <a href="https://syphir.vercel.app" style="color:#4db8f0;">syphir.vercel.app</a>.</div>
              </div>
              <p style="color:#4a5568;font-size:12px;line-height:1.6;">Want to pick a plan now? <a href="https://syphir.vercel.app/dashboard/pricing.html?key=${bizKey}" style="color:#4db8f0;">View plans</a>. Questions? Just reply to this email.</p>
            </div>
          `,
        });
      } catch(emailErr) { console.warn('[Admin] Approval email failed:', emailErr.message); }
    }

    console.log(`[Admin] Approved signup: ${org.name} (${org.admin_email})`);
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── ADMIN: REJECT A PENDING SIGNUP ────────────────────────────────────────
app.post("/admin/reject-signup", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  const { org_id } = await c.req.json().catch(() => ({}));
  if (!org_id) return c.json({ error: "org_id required" }, 400);

  try {
    await db(`organizations?id=eq.${encodeURIComponent(org_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ signup_status: "rejected", active: false }),
    });
    const keys = await db(`license_keys?org_id=eq.${encodeURIComponent(org_id)}&select=*`).catch(() => []);
    for (const k of (keys || [])) {
      await db(`license_keys?id=eq.${encodeURIComponent(k.id)}`, {
        method: "PATCH", prefer: "return=minimal",
        body: JSON.stringify({ status: "inactive" }),
      }).catch(() => {});
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── ADMIN: DEDUP ORGS ─────────────────────────────────────────────────────
app.post("/admin/dedup-orgs", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
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
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

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
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
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

  // ── invoice.payment_succeeded — fires on every successful recurring payment
  // Ensures keys never expire as long as billing is current
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    if (customerId) {
      try {
        // Find org by stripe_customer_id and clear expiry
        const orgs = await dbWithRetry(
          `organizations?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id,name,plan`
        ).catch(() => []);
        if (orgs?.length) {
          const org = orgs[0];
          await dbWithRetry(`organizations?id=eq.${encodeURIComponent(org.id)}`, {
            method: "PATCH", prefer: "return=minimal",
            body: JSON.stringify({ active: true }),
          });
          await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(org.id)}`, {
            method: "PATCH", prefer: "return=minimal",
            body: JSON.stringify({ expires_at: null, status: "active" }),
          });
          console.log(`✓ Recurring payment: cleared expiry for org ${org.id} (${org.name})`);
        }
      } catch (err) {
        console.error("Failed to clear expiry on invoice.payment_succeeded:", err.message);
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

// ── STANDALONE EMAIL FUNCTIONS (called by both HTTP endpoints and scheduler) ─

async function sendWeeklyReportsToAllOrgs(targetOrgId = null) {
  const now       = new Date();
  const dateLabel = now.toISOString().slice(0, 10);

  let orgs;
  try {
    orgs = targetOrgId
      ? await db(`organizations?id=eq.${encodeURIComponent(targetOrgId)}&select=*`)
      : await db('organizations?active=eq.true&select=*');
  } catch (err) {
    console.error('sendWeeklyReports: failed to load orgs:', err.message);
    return { error: err.message };
  }
  if (!orgs || orgs.length === 0) return { sent: 0, skipped: 0 };

  const results = [];
  for (const org of orgs) {
    if (!org.admin_email) { results.push({ org: org.name, skipped: 'no email' }); continue; }
    try {
      // Filter by plan column (no status column in organizations table)
      const planLower    = (org.plan || '').toLowerCase();
      const isPaid       = ['starter', 'professional', 'institution', 'business'].includes(planLower);
      const isActiveTrial = planLower === 'demo' || planLower === 'trial';
      const isCancelled  = planLower === 'cancelled' || planLower === 'expired';
      const trialExpired = isActiveTrial && org.expires_at && new Date(org.expires_at) <= now;

      if (isCancelled || trialExpired || (!isPaid && !isActiveTrial)) {
        console.log('Scheduler: skipping', org.name, '— plan:', org.plan, 'expires:', org.expires_at);
        results.push({ org: org.name, skipped: `plan:${org.plan} expires:${org.expires_at || 'none'}` });
        continue;
      }

      const isDemo      = isActiveTrial;
      const windowMs    = isDemo ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      const windowStart = new Date(now.getTime() - windowMs);
      const periodLabel = windowStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        + ' – ' + now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      const incidents = await db(
        `incidents?org_id=eq.${encodeURIComponent(org.id)}&timestamp=gte.${encodeURIComponent(windowStart.toISOString())}&order=timestamp.desc`
      ).catch(() => []) || [];

      console.log('Incidents found for', org.name, ':', incidents.length);

      const keyRows = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
      ).catch(() => []) || [];
      const orgKey   = keyRows[0]?.key || '';
      const slugName = org.name.toLowerCase().replace(/[^a-z0-9]/g, '-');

      if (incidents.length === 0) {
        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
          subject: `Syphir Weekly Recap: All clear this week — ${org.name}`,
          html: buildQuietWeekHtml(org, periodLabel.split(' – ')[0], periodLabel.split(' – ')[1], orgKey),
        });
      } else {
        const total       = incidents.length;
        const attachments = [];
        try {
          const pdfBuf = await generateWeeklyPdf(org, incidents, periodLabel, dateLabel);
          attachments.push({ filename: `syphir-report-${slugName}-${dateLabel}.pdf`, content: pdfBuf.toString('base64') });
        } catch (pdfErr) {
          console.warn('PDF generation failed for', org.name, ':', pdfErr.message);
        }
        const csvContent = buildIncidentCsv(incidents);
        attachments.push({ filename: `syphir-report-${slugName}-${dateLabel}.csv`, content: Buffer.from(csvContent).toString('base64') });

        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: org.admin_email,
          subject: `Syphir Weekly Recap: ${total} incidents detected at ${org.name} this week`,
          html: buildShortWeeklyHtml(org, incidents, orgKey, periodLabel),
          attachments,
        });
      }
      console.log('Email sent: weekly-report', org.name, org.admin_email);
      results.push({ org: org.name, incidents: incidents.length, sent: true });
    } catch (err) {
      console.error('Weekly report failed for', org.name, ':', err.message);
      results.push({ org: org.name, error: err.message });
    }
  }
  return { sent: results.filter(r => r.sent).length, total: orgs.length, results };
}

async function sendExpiryWarningsToAllOrgs() {
  const now     = new Date();
  const in3days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  let orgs;
  try {
    orgs = await db(
      `organizations?expires_at=gte.${encodeURIComponent(now.toISOString())}&expires_at=lte.${encodeURIComponent(in3days.toISOString())}&or=(expiry_warning_sent.is.null,expiry_warning_sent.is.false)&select=*`
    );
  } catch (err) {
    console.error('sendExpiryWarnings: failed to query orgs:', err.message);
    return { error: err.message };
  }
  if (!orgs || orgs.length === 0) return { sent: 0, message: 'No orgs expiring in 3 days' };

  const results = [];
  for (const org of orgs) {
    if (!org.admin_email) { results.push({ org: org.name, skipped: 'no email' }); continue; }
    try {
      const incidents  = await db(`incidents?org_id=eq.${encodeURIComponent(org.id)}&order=timestamp.desc`).catch(() => []) || [];
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
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ expiry_warning_sent: true }),
        });
      } catch(_) {}

      console.log('Email sent: expiry-warning', org.name, org.admin_email);
      results.push({ org: org.name, sent: true });
    } catch (err) {
      console.error('Expiry warning failed for', org.name, ':', err.message);
      results.push({ org: org.name, error: err.message });
    }
  }
  return { sent: results.filter(r => r.sent).length, total: orgs.length, results };
}

async function sendExpiryNoticesToAllOrgs() {
  const now = new Date();

  let orgs;
  try {
    orgs = await db(
      `organizations?expires_at=lt.${encodeURIComponent(now.toISOString())}&or=(expiry_notice_sent.is.null,expiry_notice_sent.is.false)&select=*`
    );
  } catch (err) {
    console.error('sendExpiryNotices: failed to query orgs:', err.message);
    return { error: err.message };
  }
  if (!orgs || orgs.length === 0) return { sent: 0, message: 'No expired orgs found' };

  const results = [];
  for (const org of orgs) {
    if (!org.admin_email) { results.push({ org: org.name, skipped: 'no email' }); continue; }
    try {
      const incidents  = await db(`incidents?org_id=eq.${encodeURIComponent(org.id)}&order=timestamp.desc`).catch(() => []) || [];
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
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ expiry_notice_sent: true }),
        });
      } catch(_) {}

      console.log('Email sent: expiry-notice', org.name, org.admin_email);
      results.push({ org: org.name, sent: true });
    } catch (err) {
      console.error('Expiry notice failed for', org.name, ':', err.message);
      results.push({ org: org.name, error: err.message });
    }
  }
  return { sent: results.filter(r => r.sent).length, total: orgs.length, results };
}

// ── ADMIN: Clear expiry — for paid orgs or manual overrides ────────────────
app.post("/admin/clear-expiry", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  const { org_id, key } = await c.req.json().catch(() => ({}));

  // Resolve org_id from key if not provided directly
  let resolvedOrgId = org_id;
  if (!resolvedOrgId && key) {
    const rows = await db(`license_keys?key=eq.${encodeURIComponent(key)}&select=org_id`).catch(() => []);
    resolvedOrgId = rows?.[0]?.org_id;
  }
  if (!resolvedOrgId) return c.json({ error: "Provide org_id or key" }, 400);

  try {
    await dbWithRetry(`organizations?id=eq.${encodeURIComponent(resolvedOrgId)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ active: true }),
    });
    await dbWithRetry(`license_keys?org_id=eq.${encodeURIComponent(resolvedOrgId)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({ expires_at: null, status: "active" }),
    });
    console.log(`✓ Admin cleared expiry for org ${resolvedOrgId}`);
    return c.json({ success: true, org_id: resolvedOrgId, message: "Expiry cleared — key is now permanent" });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── WEEKLY REPORTS ─────────────────────────────────────────────────────────
app.post("/admin/send-weekly-reports", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await sendWeeklyReportsToAllOrgs(body.org_id || null));
});

// ── EXPIRY WARNINGS ─────────────────────────────────────────────────────────
app.post("/admin/send-expiry-warnings", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await sendExpiryWarningsToAllOrgs());
});

// ── EXPIRY NOTICES ──────────────────────────────────────────────────────────
app.post("/admin/send-expiry-notices", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await sendExpiryNoticesToAllOrgs());
});

// ── Validate key by email — for returning customers ───────────────────────────
app.post('/validate-key-by-email', async (c) => {
  const { email } = await c.req.json().catch(() => ({}));
  if (!email) return c.json({ valid: false });
  try {
    const orgs = await db(`organizations?admin_email=eq.${encodeURIComponent(email.toLowerCase())}&select=*`).catch(() => []);
    if (!orgs?.length) return c.json({ valid: false });
    const org = orgs[0];
    if (!org.active) return c.json({ valid: false, expired: true });
    const keys = await db(`license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`).catch(() => []);
    const key = keys?.[0]?.key;
    if (!key) return c.json({ valid: false });
    return c.json({ valid: true, key, org_name: org.name, org_id: org.id, plan: org.plan });
  } catch(e) {
    return c.json({ valid: false });
  }
});

// ── AUTH: Provision by email only (no Supabase token needed) ────────────────
// Used by the simple "sign in with email" flow — no magic link wait.
app.post('/auth/provision-email', async (c) => {
  if (isRateLimited(c, "provision-email", 20, 60_000)) return c.json({ error: "Too many attempts. Slow down." }, 429);
  const { email } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);

  const userEmail = email.toLowerCase().trim();

  try {
    // Check if org already exists for this email
    const existing = await db(
      `organizations?admin_email=eq.${encodeURIComponent(userEmail)}&select=*`
    ).catch(() => []);

    if (existing?.length) {
      const org = existing[0];

      // Still waiting on manual approval — don't hand out a key yet.
      if (org.signup_status === 'pending') {
        console.log(`[Auth] Pending signup checked in again: ${userEmail} → org ${org.id}`);
        return c.json({ pending: true, is_new: false, org_id: org.id });
      }
      if (org.signup_status === 'rejected') {
        return c.json({ error: 'This signup was not approved. Contact syphir26@gmail.com for details.' }, 403);
      }

      const keys = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
      ).catch(() => []);
      const key = keys?.[0]?.key;
      if (!key) return c.json({ error: 'No active key found. Contact support.' }, 404);

      console.log(`[Auth] Returning user (email): ${userEmail} → org ${org.id}`);
      return c.json({ key, org_name: org.name, org_id: org.id, plan: org.plan, is_new: false });
    }

    // No org for this email yet — tell the frontend to collect a couple more
    // details before we create anything. Nothing is written to the DB here.
    return c.json({ exists: false });

  } catch(err) {
    console.error('[Auth] provision-email error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── AUTH: Submit a trial request — creates a PENDING org, no dashboard access yet ──
// Trial + keys only activate once approved from the admin panel.
app.post('/auth/signup-request', async (c) => {
  if (isRateLimited(c, "signup-request", 10, 60_000)) return c.json({ error: "Too many attempts. Try again shortly." }, 429);
  const { email, business_name, phone } = await c.req.json().catch(() => ({}));
  if (!email || !email.includes('@')) return c.json({ error: 'Valid email required' }, 400);
  if (!business_name || !business_name.trim()) return c.json({ error: 'Business name required' }, 400);

  const userEmail = email.toLowerCase().trim();
  const orgName = business_name.trim();
  const userPhone = (phone || '').trim();

  try {
    // Guard against double-submits / racing tabs
    const existing = await db(
      `organizations?admin_email=eq.${encodeURIComponent(userEmail)}&select=*`
    ).catch(() => []);
    if (existing?.length) {
      const org = existing[0];
      if (org.signup_status === 'pending') return c.json({ pending: true, is_new: false, org_id: org.id });
      if (org.signup_status === 'rejected') return c.json({ error: 'This signup was not approved. Contact syphir26@gmail.com for details.' }, 403);
      return c.json({ error: 'An account already exists for this email.' }, 409);
    }

    const bizKey = genKey();
    const empKey = genEmpKey();

    // Create the org. If the optional signup_status/phone columns aren't in the
    // schema yet, fall back to a minimal insert so signup still works.
    let newOrg;
    try {
      newOrg = await db('organizations', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          name: orgName, admin_email: userEmail, phone: userPhone, plan: 'Demo',
          active: false, signup_status: 'pending',
        }),
      });
    } catch (colErr) {
      console.warn('[Auth] Full org insert failed, retrying minimal:', colErr.message);
      newOrg = await db('organizations', {
        method: 'POST', prefer: 'return=representation',
        body: JSON.stringify({
          name: orgName, admin_email: userEmail, plan: 'Demo', active: false,
        }),
      });
    }
    const orgId = newOrg?.[0]?.id;
    if (!orgId) return c.json({ error: 'Failed to create organization' }, 500);

    // Keys are created inactive — validate-key naturally rejects them until approved.
    // Fall back to 'inactive' if the 'pending' status value isn't accepted.
    async function makeKey(key, keyType) {
      try {
        await db('license_keys', {
          method: 'POST', prefer: 'return=minimal',
          body: JSON.stringify({ key, org_id: orgId, key_type: keyType, status: 'pending' }),
        });
      } catch (kErr) {
        console.warn('[Auth] Key insert (pending) failed, retrying inactive:', kErr.message);
        await db('license_keys', {
          method: 'POST', prefer: 'return=minimal',
          body: JSON.stringify({ key, org_id: orgId, key_type: keyType, status: 'inactive' }),
        });
      }
    }
    await makeKey(bizKey, 'business');
    await makeKey(empKey, 'employee');

    console.log(`[Auth] New signup request (pending approval): ${orgName} (${userEmail}) ${userPhone}`);

    // Confirmation email — no key yet, just a heads-up that it's under review.
    try {
      await resend.emails.send({
        from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: userEmail,
        subject: `We got your Syphir signup request`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0d1117;color:#e6edf3;">
            <div style="font-size:22px;font-weight:700;margin-bottom:8px;">Thanks for signing up. 🛡️</div>
            <p style="color:#8b949e;margin-bottom:12px;line-height:1.6;">We've got your request for a Syphir trial. We personally review every signup — you'll get a follow-up email with your dashboard key and a link to pick a plan shortly.</p>
            <p style="color:#4a5568;font-size:12px;line-height:1.6;">Questions in the meantime? Just reply to this email.</p>
          </div>
        `,
      });
    } catch(emailErr) { console.warn('[Auth] Signup confirmation email failed:', emailErr.message); }

    return c.json({ pending: true, is_new: true, org_id: orgId });

  } catch(err) {
    console.error('[Auth] signup-request error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── AUTH: Provision org after Supabase login ──────────────────────────────────
// Called after Google OAuth or magic link — creates org if new, returns key if existing
app.post('/auth/provision', async (c) => {
  // Verify Supabase JWT
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return c.json({ error: 'Missing auth token' }, 401);

  // Decode JWT to get user info (verify with Supabase)
  let userEmail, userId;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_KEY }
    });
    if (!r.ok) return c.json({ error: 'Invalid session' }, 401);
    const user = await r.json();
    userEmail = user.email?.toLowerCase();
    userId    = user.id;
    if (!userEmail) return c.json({ error: 'No email on account' }, 400);
  } catch(e) {
    return c.json({ error: 'Auth verification failed' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const displayName = body.name || userEmail.split('@')[0];

  try {
    // Check if org already exists for this email
    const existing = await db(
      `organizations?admin_email=eq.${encodeURIComponent(userEmail)}&select=*`
    ).catch(() => []);

    if (existing?.length) {
      const org = existing[0];
      // Fetch their business key
      const keys = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&key_type=eq.business&status=eq.active&select=key`
      ).catch(() => []);
      const key = keys?.[0]?.key;
      if (!key) return c.json({ error: 'No active key found. Contact support.' }, 404);

      console.log(`[Auth] Returning user: ${userEmail} → org ${org.id}`);
      return c.json({
        key,
        org_name: org.name,
        org_id:   org.id,
        plan:     org.plan,
        is_new:   false,
      });
    }

    // ── New user — create org with Demo plan, 7-day trial ──
    const bizKey = genKey();
    const empKey = genEmpKey();
    const orgName = displayName.includes('@')
      ? displayName.split('@')[0].replace(/[^a-zA-Z0-9 ]/g,' ').trim() + "'s Organization"
      : displayName + "'s Organization";
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Create org
    const newOrg = await db('organizations', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify({
        name:        orgName,
        admin_email: userEmail,
        plan:        'Demo',
        active:      true,
        expires_at:  expiresAt,
        supabase_uid: userId,
      }),
    });
    const orgId = newOrg?.[0]?.id;
    if (!orgId) return c.json({ error: 'Failed to create organization' }, 500);

    // Create business key
    await db('license_keys', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        key:      bizKey,
        org_id:   orgId,
        key_type: 'business',
        status:   'active',
        expires_at: expiresAt,
      }),
    });

    // Create employee key
    await db('license_keys', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        key:      empKey,
        org_id:   orgId,
        key_type: 'employee',
        status:   'active',
        expires_at: expiresAt,
      }),
    });

    console.log(`[Auth] New org created: ${orgName} (${userEmail}) → ${bizKey}`);

    // Send welcome email
    try {
      await resend.emails.send({
        from:    EMAIL_FROM,
        replyTo: EMAIL_REPLYTO,
        to:      userEmail,
        subject: `Welcome to Syphir — your 7-day trial is active`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0d1117;color:#e6edf3;">
            <div style="font-size:22px;font-weight:700;margin-bottom:8px;">You're in. 🛡️</div>
            <p style="color:#8b949e;margin-bottom:24px;line-height:1.6;">Your Syphir AI Data Protection trial is active for the next 7 days. Here's everything you need:</p>
            <div style="background:#161b22;border:1px solid #1e2636;border-radius:10px;padding:20px;margin-bottom:20px;">
              <div style="font-size:11px;color:#4a5568;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">DASHBOARD KEY</div>
              <div style="font-size:20px;font-weight:700;font-family:'Courier New',monospace;color:#4db8f0;letter-spacing:1px;">${bizKey}</div>
              <div style="font-size:11px;color:#4a5568;margin-top:8px;">Keep this safe — it's your login.</div>
            </div>
            <div style="background:#161b22;border:1px solid #1e2636;border-radius:10px;padding:20px;margin-bottom:24px;">
              <div style="font-size:11px;color:#4a5568;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">EMPLOYEE KEY (share with staff)</div>
              <div style="font-size:16px;font-weight:700;font-family:'Courier New',monospace;color:#8b949e;letter-spacing:1px;">${empKey}</div>
            </div>
            <a href="https://syphir.vercel.app/dashboard/app.html?key=${bizKey}&org=${encodeURIComponent(orgName)}"
               style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-bottom:20px;">
              Open Dashboard →
            </a>
            <p style="color:#4a5568;font-size:12px;line-height:1.6;">Your trial lasts 7 days. After that, choose a plan to keep your team protected. Questions? Reply to this email.</p>
          </div>
        `,
      });
    } catch(emailErr) {
      console.warn('[Auth] Welcome email failed:', emailErr.message);
    }

    return c.json({
      key:      bizKey,
      emp_key:  empKey,
      org_name: orgName,
      org_id:   orgId,
      plan:     'Demo',
      is_new:   true,
      expires_at: expiresAt,
    });

  } catch(err) {
    console.error('[Auth] provision error:', err.message);
    return c.json({ error: err.message }, 500);
  }
});

// ── AUTH: Account recovery — resend key to email ─────────────────────────────
app.post('/auth/recover', async (c) => {
  if (isRateLimited(c, "recover", 5, 60_000)) return c.json({ error: "Too many attempts. Try again shortly." }, 429);
  const { email } = await c.req.json().catch(() => ({}));
  if (!email) return c.json({ sent: false }, 400);

  // Always return 200 — don't reveal if email exists
  try {
    const orgs = await db(
      `organizations?admin_email=eq.${encodeURIComponent(email.toLowerCase())}&select=*`
    ).catch(() => []);

    if (orgs?.length) {
      const org = orgs[0];
      const keys = await db(
        `license_keys?org_id=eq.${encodeURIComponent(org.id)}&status=eq.active&select=key,key_type`
      ).catch(() => []);
      const bizKey = keys?.find(k => k.key_type === 'business')?.key;
      const empKey = keys?.find(k => k.key_type === 'employee')?.key;

      if (bizKey) {
        const dashUrl = `https://syphir.vercel.app/dashboard/app.html?key=${bizKey}&org=${encodeURIComponent(org.name)}`;
        await resend.emails.send({
          from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: email,
          subject: `Your Syphir dashboard access — ${org.name}`,
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0d1117;color:#e6edf3;">
              <div style="font-size:18px;font-weight:700;margin-bottom:8px;">🔑 Your Syphir keys</div>
              <p style="color:#8b949e;margin-bottom:20px;line-height:1.6;">You requested account recovery for <strong>${org.name}</strong>. Here are your access details:</p>
              <div style="background:#161b22;border:1px solid #1e2636;border-radius:10px;padding:18px;margin-bottom:14px;">
                <div style="font-size:11px;color:#4a5568;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">DASHBOARD KEY (admin login)</div>
                <div style="font-size:18px;font-weight:700;font-family:'Courier New',monospace;color:#4db8f0;letter-spacing:1px;">${bizKey}</div>
              </div>
              ${empKey ? `<div style="background:#161b22;border:1px solid #1e2636;border-radius:10px;padding:18px;margin-bottom:20px;">
                <div style="font-size:11px;color:#4a5568;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">EMPLOYEE KEY (share with staff)</div>
                <div style="font-size:15px;font-weight:700;font-family:'Courier New',monospace;color:#8b949e;letter-spacing:1px;">${empKey}</div>
              </div>` : ''}
              <a href="${dashUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;margin-bottom:20px;">Open Dashboard →</a>
              <p style="color:#4a5568;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
          `,
        });
        console.log(`[Auth] Recovery email sent to ${email}`);
      }
    }
    // Always return 200
    return c.json({ sent: true });
  } catch(err) {
    console.error('[Auth] recover error:', err.message);
    return c.json({ sent: true }); // don't expose errors
  }
});

// ── SHIELD: Live device scanner ────────────────────────────────────────────
// In-memory store per org (Pi pushes every 30s, refills after Render spin-down)
const shieldDeviceStore = {};

// Pi → Render: push scan results
app.post('/shield/devices', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.org_key) return c.json({ error: 'Missing org_key' }, 400);

  shieldDeviceStore[body.org_key] = {
    org_key:      body.org_key,
    subnet:       body.subnet       || '',
    device_count: body.device_count || 0,
    devices:      body.devices      || [],
    scanned_at:   body.scanned_at   || new Date().toISOString(),
    received_at:  new Date().toISOString(),
  };

  console.log(`[Shield] ${body.org_key} → ${body.device_count} devices on ${body.subnet}`);
  return c.json({ status: 'ok', received: body.device_count });
});

// Dashboard → Render: poll for latest scan
app.get('/shield/devices', async (c) => {
  const key = c.req.query('key') || c.req.query('org_key');
  if (!key) return c.json({ error: 'Missing key' }, 400);

  const data = shieldDeviceStore[key];
  if (!data) return c.json({ devices: [], scanned_at: null, device_count: 0, online: false });

  // Flag as stale if last scan was >2 min ago (Pi offline)
  const age = Date.now() - new Date(data.received_at).getTime();
  return c.json({ ...data, online: age < 120_000, stale: age > 120_000 });
});

// Shield heartbeat — Pi pings this every 60s to confirm it's alive
app.post('/shield/heartbeat', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.org_key) return c.json({ error: 'Missing org_key' }, 400);

  const existing = shieldDeviceStore[body.org_key] || {};
  shieldDeviceStore[body.org_key] = {
    ...existing,
    heartbeat_at: new Date().toISOString(),
    shield_ip:    body.shield_ip   || '',
    version:      body.version     || '',
  };

  console.log(`[Shield] heartbeat from ${body.org_key} @ ${body.shield_ip || 'unknown'}`);
  return c.json({ status: 'ok', time: new Date().toISOString() });
});

console.log("Syphir API v2.11.0 running");

// ── KEEP RENDER ALIVE ───────────────────────────────────────────────────────
setInterval(() => fetch("https://syphir-api.onrender.com/health").catch(() => {}), 10 * 60 * 1000);

// ── IN-PROCESS SCHEDULER (backup: GitHub Actions cron also configured) ──────
// Fires weekly reports Friday 8am PST; expiry emails daily 9am PST.
// Uses in-memory last-run tracking to prevent double-firing within the same day.
const lastRun = { weekly: null, expiry: null };

setInterval(async () => {
  try {
    const pst     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const day     = pst.getDay();   // 0 Sun … 5 Fri … 6 Sat
    const hour    = pst.getHours();
    const dateStr = pst.toDateString();

    if (day === 5 && hour === 8 && lastRun.weekly !== dateStr) {
      lastRun.weekly = dateStr;
      console.log('Scheduler: running weekly reports', new Date().toISOString());
      await sendWeeklyReportsToAllOrgs(null);
      console.log('Scheduler: weekly reports sent', dateStr);
    }

    if (hour === 9 && lastRun.expiry !== dateStr) {
      lastRun.expiry = dateStr;
      console.log('Scheduler: running expiry emails', new Date().toISOString());
      await sendExpiryWarningsToAllOrgs();
      await sendExpiryNoticesToAllOrgs();
      console.log('Scheduler: expiry emails sent', dateStr);
    }
  } catch (err) {
    console.error('Scheduler error:', err.message);
  }
}, 60 * 60 * 1000); // check every hour

export default { port: 3000, fetch: app.fetch };