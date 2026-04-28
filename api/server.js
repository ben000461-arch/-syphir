import { Hono } from "hono";
import { cors } from "hono/cors";
import { Resend } from "resend";
import Stripe from "stripe";

const app = new Hono();
const SCANNER_URL = "https://syphir-scanner.onrender.com";
const SUPABASE_URL = "https://pfrojobhrmfnoxavlrmm.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmcm9qb2Jocm1mbm94YXZscm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MTU5MDcsImV4cCI6MjA5MTQ5MTkwN30.0FFbJq_gwsFtZSQY7isojouZAT3xWAUBGFXx-j9nbzo";
const resend = new Resend("re_efn93Zvb_47cNT8pdRWnhnvHFnfhQ7yqR");
const ADMIN_SECRET = "bridgeline2025";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const STRIPE_PLANS = {
  Starter:      { amount: 9900,  label: "Syphir Starter — $99/mo" },
  Professional: { amount: 24900, label: "Syphir Professional — $249/mo" },
  Institution:  { amount: 59900, label: "Syphir Institution — $599/mo" },
};

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

// ── CORS ───────────────────────────────────────────────────────────────────
app.use("/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Admin-Secret", "Authorization"],
  exposeHeaders: ["Content-Type"],
  credentials: false,
}));

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "Syphir API", version: "2.5.0", db: "supabase" });
});

// ── VALIDATE KEY ───────────────────────────────────────────────────────────
app.post("/validate-key", async (c) => {
  const { key, context } = await c.req.json();
  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
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
    return c.json({ valid: true, key_type: keyType, org_id: org.id, org_name: org.name, plan: org.plan, expires_at: row.expires_at, days_left: daysLeft });
  } catch (err) {
    return c.json({ valid: false, message: "Validation failed" }, 500);
  }
});

// ── SCAN ───────────────────────────────────────────────────────────────────
app.post("/scan", async (c) => {
  const { text, key, user_email, ai_tool, url } = await c.req.json();
  let org;
  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ valid: false, message: "Invalid key" }, 401);
    org = rows[0].organizations;
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
      const incident = {
        id: `inc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        org_id: org.id, org_name: org.name, user_email, ai_tool, url,
        detections: result.detections, risk_level: result.risk_level,
        message: result.message, resolved: false, timestamp: new Date().toISOString(),
      };
      await db("incidents", { method: "POST", prefer: "return=minimal", body: JSON.stringify(incident) });
    }
    return c.json({ flagged: result.flagged, risk_level: result.risk_level, message: result.message, detections: result.detections });
  } catch (err) {
    return c.json({ flagged: false, message: "Scanner unavailable" }, 500);
  }
});

// ── LOG INCIDENT DIRECTLY ──────────────────────────────────────────────────
app.post("/log-incident", async (c) => {
  const { key, user_email, ai_tool, url, risk_level, detections, message, id, timestamp } = await c.req.json();
  let org;
  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ success: false, message: "Invalid key" }, 401);
    org = rows[0].organizations;
  } catch (err) { return c.json({ success: false, message: "Auth failed" }, 500); }
  try {
    const incident = {
      id: id || `inc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      org_id: org.id, org_name: org.name,
      user_email: user_email || "unknown",
      ai_tool: ai_tool || "AI Tool", url: url || "",
      detections: detections || [], risk_level: risk_level || "low",
      message: message || "PII detected", resolved: false,
      timestamp: timestamp || new Date().toISOString(),
    };
    await db("incidents", { method: "POST", prefer: "return=minimal", body: JSON.stringify(incident) });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, message: err.message }, 500);
  }
});

// ── EMP KEY ────────────────────────────────────────────────────────────────
app.get("/emp-key/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const rows = await db(`license_keys?org_id=eq.${org_id}&key_type=eq.employee&status=eq.active&select=key`);
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
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Not found" }, 404);
    const org = rows[0].organizations;
    const keyType = rows[0].key_type;
    return c.json({ ...org, key_type: keyType });
  } catch (err) {
    return c.json({ error: "Failed" }, 500);
  }
});

// ── PATCH ORG (save settings) ──────────────────────────────────────────────
app.patch("/org/:org_id", async (c) => {
  const { org_id } = c.req.param();
  const body = await c.req.json();
  const allowed = {};
  if (body.name)        allowed.name        = body.name;
  if (body.admin_email) allowed.admin_email = body.admin_email;
  try {
    await db(`organizations?id=eq.${org_id}`, {
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
  if (adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
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
    const incidents = await db(`incidents?org_id=eq.${org_id}&order=timestamp.desc&limit=100`);
    return c.json({ incidents: incidents || [], total: incidents?.length || 0 });
  } catch (err) {
    return c.json({ incidents: [], total: 0 });
  }
});

app.get("/stats/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const incidents = await db(`incidents?org_id=eq.${org_id}&select=risk_level,resolved`);
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
    await db(`incidents?id=eq.${id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ resolved: true, resolved_at: new Date().toISOString() }) });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

// ── TEAM ───────────────────────────────────────────────────────────────────
app.get("/team/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const users = await db(`users?org_id=eq.${org_id}&order=invited_at.desc`);
    return c.json({ users: users || [] });
  } catch (err) {
    return c.json({ users: [] });
  }
});

app.patch("/team/:id/remove", async (c) => {
  const { id } = c.req.param();
  try {
    await db(`users?id=eq.${id}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ status: "removed" }) });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

app.post("/invite-user", async (c) => {
  const { org_key, employee_email, org_name } = await c.req.json();
  let org;
  try {
    const rows = await db(`license_keys?key=eq.${org_key}&status=eq.active&select=*,organizations(*)`);
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
    await resend.emails.send({ from: "Syphir Shield <onboarding@resend.dev>", to: employee_email, subject: `You've been added to ${org_name || org.name}'s Syphir Shield`, html: emailHtml });
    return c.json({ success: true, message: `Invite sent to ${employee_email}` });
  } catch (err) {
    return c.json({ success: false, message: "Failed to send email" }, 500);
  }
});

// ── ADMIN: CREATE ORG ──────────────────────────────────────────────────────
app.post("/admin/create-org", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  const { name, email, plan, status, key, emp_key } = await c.req.json();
  if (!name || !key) return c.json({ error: "name and key are required" }, 400);

  // Guard: reject if biz key already exists — prevents ghost orgs on retry
  try {
    const existing = await db(`license_keys?key=eq.${key}&select=key`);
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
      const check = await db(`license_keys?key=eq.${key}&status=eq.active&select=key`);
      if (check && check.length > 0) { verified = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!verified) {
      // Rollback: deactivate org so it doesn't appear as a ghost in the admin list
      await db(`organizations?id=eq.${orgId}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ active: false }) }).catch(() => {});
      return c.json({ error: "Key write could not be confirmed — org rolled back. Try again." }, 500);
    }

    console.log(`✓ New org: ${name} | id: ${org.id} | biz: ${key} | emp: ${emp_key || "none"}`);
    return c.json({ success: true, org_id: org.id, org_name: org.name, key, emp_key });
  } catch (err) {
    // Rollback: deactivate org if key writes failed
    if (orgId) {
      await db(`organizations?id=eq.${orgId}`, { method: "PATCH", prefer: "return=minimal", body: JSON.stringify({ active: false }) }).catch(() => {});
    }
    return c.json({ error: "Failed to create org: " + err.message }, 500);
  }
});

// ── CONTACT SUBMISSION ────────────────────────────────────────────────────
app.post("/contact", async (c) => {
  const { name, email, company, message } = await c.req.json();
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
  if (adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
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
  if (adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
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
        await dbWithRetry(`license_keys?org_id=eq.${dup.id}`, {
          method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ status: "inactive" }),
        });
        deduped.push({ 
            
          removed_id: dup.id, name: dup.name, kept_id: keep.id });
      }
    }
    return c.json({ success: true, count: deduped.length, deduped });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── ADMIN: REMOVE ORG ──────────────────────────────────────────────────────
app.delete("/admin/remove-org/:key", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (adminSecret !== ADMIN_SECRET) return c.json({ error: "Unauthorized" }, 401);
  const { key } = c.req.param();
  try {
    // Look up org_id (check all key statuses so already-inactive keys still resolve)
    const rows = await db(`license_keys?key=eq.${key}&select=org_id`);
    if (!rows || rows.length === 0) return c.json({ success: true, note: "Key not found" });
    const orgId = rows[0].org_id;

    // Hard-delete all license keys for this org, then the org itself
    await db(`license_keys?org_id=eq.${orgId}`, { method: "DELETE", prefer: "return=minimal" });
    await db(`organizations?id=eq.${orgId}`, { method: "DELETE", prefer: "return=minimal" });

    return c.json({ success: true });
  } catch (err) {
    return c.json({ error: "Failed: " + err.message }, 500);
  }
});

// ── STRIPE: CREATE CHECKOUT SESSION ───────────────────────────────────────
app.post("/create-checkout-session", async (c) => {
  if (!stripe) return c.json({ error: "Stripe not configured" }, 503);
  const { key, plan } = await c.req.json();
  if (!key || !plan) return c.json({ error: "key and plan are required" }, 400);

  const price = STRIPE_PLANS[plan];
  if (!price) return c.json({ error: `Unknown plan: ${plan}` }, 400);

  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Invalid or inactive key" }, 401);
    const org = rows[0].organizations;

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
      metadata: { org_id: org.id, org_name: org.name, key, plan },
      customer_email: org.admin_email || undefined,
      success_url: `https://syphir.vercel.app/app.html?key=${key}&payment=success`,
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
    const { org_id, plan } = session.metadata || {};
    if (org_id && plan) {
      try {
        await dbWithRetry(`organizations?id=eq.${org_id}`, {
          method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ plan, active: true, stripe_customer_id: session.customer || null }),
        });
        await dbWithRetry(`license_keys?org_id=eq.${org_id}`, {
          method: "PATCH", prefer: "return=minimal",
          body: JSON.stringify({ expires_at: null, status: "active" }),
        });
        console.log(`✓ Payment success: org ${org_id} → plan ${plan}, customer ${session.customer}`);
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
  const { key } = await c.req.json();
  if (!key) return c.json({ error: "key is required" }, 400);

  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
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

console.log("Syphir API v2.5.0 running");
// Keep Render awake — ping every 10 minutes
setInterval(() => fetch("https://syphir-api.onrender.com/health").catch(() => {}), 10 * 60 * 1000);
export default { port: 3000, fetch: app.fetch };