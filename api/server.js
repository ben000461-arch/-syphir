import { Hono } from "hono";
import { cors } from "hono/cors";

import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY || "re_efn93Zvb_47cNT8pdRWnhnvHFnfhQ7yqR");

const app = new Hono();
const SCANNER_URL = "https://syphir-scanner.onrender.com";
const SUPABASE_URL = "https://pfrojobhrmfnoxavlrmm.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmcm9qb2Jocm1mbm94YXZscm1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MTU5MDcsImV4cCI6MjA5MTQ5MTkwN30.0FFbJq_gwsFtZSQY7isojouZAT3xWAUBGFXx-j9nbzo";

// Supabase helper
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

app.use("/*", cors());

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "Syphir API", version: "1.0.0", db: "supabase" });
});

// Validate license key
app.post("/validate-key", async (c) => {
  const { key } = await c.req.json();
  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) {
      return c.json({ valid: false, message: "Invalid or expired key" }, 401);
    }
    const license = rows[0];
    const org = license.organizations;
    return c.json({
      valid: true,
      org_id: org.id,
      org_name: org.name,
      plan: org.plan,
    });
  } catch (err) {
    console.error("Key validation error:", err);
    return c.json({ valid: false, message: "Validation failed" }, 500);
  }
});

// Main scan endpoint
app.post("/scan", async (c) => {
  const body = await c.req.json();
  const { text, key, user_email, ai_tool, url } = body;

  // Validate key
  let org;
  try {
    const rows = await db(`license_keys?key=eq.${key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) {
      return c.json({ valid: false, message: "Invalid key" }, 401);
    }
    org = rows[0].organizations;
  } catch (err) {
    return c.json({ valid: false, message: "Auth failed" }, 500);
  }

  // Send to scanner
  try {
    const scanResponse = await fetch(`${SCANNER_URL}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        org_id: org.id,
        user_id: user_email,
        ai_tool,
      }),
    });

    const result = await scanResponse.json();

    // Save incident to Supabase if flagged
    if (result.flagged) {
      const incident = {
        id: `inc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        org_id: org.id,
        org_name: org.name,
        user_email,
        ai_tool,
        url,
        detections: result.detections,
        risk_level: result.risk_level,
        message: result.message,
        resolved: false,
        timestamp: new Date().toISOString(),
      };

      await db("incidents", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify(incident),
      });

      console.log(`🚨 INCIDENT SAVED: ${user_email} sent ${result.risk_level} risk data to ${ai_tool}`);
    }

    return c.json({
      flagged: result.flagged,
      risk_level: result.risk_level,
      message: result.message,
      detections: result.detections,
    });

  } catch (err) {
    console.error("Scan error:", err);
    return c.json({ flagged: false, message: "Scanner unavailable" }, 500);
  }
});

// Get incidents for org
app.get("/incidents/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const incidents = await db(
      `incidents?org_id=eq.${org_id}&order=timestamp.desc&limit=100`
    );
    return c.json({ incidents: incidents || [], total: incidents?.length || 0 });
  } catch (err) {
    return c.json({ incidents: [], total: 0 });
  }
});

// Get stats
app.get("/stats/:org_id", async (c) => {
  const { org_id } = c.req.param();
  try {
    const incidents = await db(
      `incidents?org_id=eq.${org_id}&select=risk_level,resolved`
    );
    const list = incidents || [];
    const high = list.filter(i => i.risk_level === "high").length;
    const medium = list.filter(i => i.risk_level === "medium").length;
    const low = list.filter(i => i.risk_level === "low").length;
    const resolved = list.filter(i => i.resolved).length;

    return c.json({
      total_incidents: list.length,
      high_risk: high,
      medium_risk: medium,
      low_risk: low,
      resolved,
      unresolved: list.length - resolved,
    });
  } catch (err) {
    return c.json({ total_incidents: 0, high_risk: 0, medium_risk: 0, low_risk: 0, resolved: 0, unresolved: 0 });
  }
});

// Resolve incident
app.patch("/incidents/:id/resolve", async (c) => {
  const { id } = c.req.param();
  try {
    await db(`incidents?id=eq.${id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        resolved: true,
        resolved_at: new Date().toISOString(),
      }),
    });
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false }, 500);
  }
});

// Validate key for org info
app.get("/org/:key", async (c) => {
  const { key } = c.req.param();
  try {
    const rows = await db(`license_keys?key=eq.${key}&select=*,organizations(*)`);
    if (!rows || rows.length === 0) return c.json({ error: "Not found" }, 404);
    return c.json(rows[0].organizations);
  } catch (err) {
    return c.json({ error: "Failed" }, 500);
  }
});

// Invite team member
app.post("/invite-user", async (c) => {
  const { org_key, employee_email, org_name } = await c.req.json();

  // Validate org key
  let org;
  try {
    const rows = await db(`license_keys?key=eq.${org_key}&status=eq.active&select=*,organizations(*)`);
    if (!rows || rows.length === 0) {
      return c.json({ success: false, message: "Invalid key" }, 401);
    }
    org = rows[0].organizations;
  } catch (err) {
    return c.json({ success: false, message: "Auth failed" }, 500);
  }

  // Save user to Supabase
  try {
    await db("users", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        id: `user_${Date.now()}`,
        org_id: org.id,
        email: employee_email,
        role: "member",
        status: "invited",
        invited_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.log("User save error — users table may not exist yet:", err.message);
  }

  // Send invite email
  const installUrl = `https://syphir-dashboard.vercel.app/install.html?key=${org_key}&email=${employee_email}&org=${encodeURIComponent(org_name || org.name)}`;

  try {
    await resend.emails.send({
      from: "Syphir Shield <onboarding@resend.dev>",
      to: employee_email,
      subject: `You've been added to ${org_name || org.name}'s Syphir Shield`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width">
        </head>
        <body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
          <div style="max-width:560px;margin:0 auto;padding:40px 20px;">

            <!-- Header -->
            <div style="text-align:center;margin-bottom:32px;">
              <div style="font-size:32px;margin-bottom:8px;">🛡️</div>
              <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px;">
                Sy<span style="color:#4db8f0;">phir</span>
              </div>
            </div>

            <!-- Card -->
            <div style="background:#161b25;border:1px solid #242d3e;border-radius:12px;padding:32px;">
              <h1 style="color:#e6edf3;font-size:20px;font-weight:700;margin:0 0 12px;">
                You've been protected 🛡️
              </h1>
              <p style="color:#8b949e;font-size:14px;line-height:1.6;margin:0 0 24px;">
                <strong style="color:#e6edf3;">${org_name || org.name}</strong> has added you to their 
                Syphir Shield data protection system. Syphir monitors AI tool usage 
                and alerts you when sensitive data is detected — keeping your company 
                compliant and protected.
              </p>

              <!-- Steps -->
              <div style="margin-bottom:28px;">
                <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;">
                  <div style="width:24px;height:24px;background:#2196d3;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">1</div>
                  <div>
                    <div style="color:#e6edf3;font-size:13px;font-weight:600;">Install Syphir Shield</div>
                    <div style="color:#8b949e;font-size:12px;margin-top:2px;">Click the button below to add to Chrome</div>
                  </div>
                </div>
                <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;">
                  <div style="width:24px;height:24px;background:#2196d3;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">2</div>
                  <div>
                    <div style="color:#e6edf3;font-size:13px;font-weight:600;">Shield activates automatically</div>
                    <div style="color:#8b949e;font-size:12px;margin-top:2px;">No setup needed — you're protected instantly</div>
                  </div>
                </div>
                <div style="display:flex;align-items:flex-start;gap:12px;">
                  <div style="width:24px;height:24px;background:#2196d3;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">3</div>
                  <div>
                    <div style="color:#e6edf3;font-size:13px;font-weight:600;">Use AI tools normally</div>
                    <div style="color:#8b949e;font-size:12px;margin-top:2px;">Syphir runs silently in the background</div>
                  </div>
                </div>
              </div>

              <!-- CTA Button -->
              <a href="${installUrl}" style="
                display:block;
                background:#2196d3;
                color:#fff;
                text-align:center;
                padding:14px 24px;
                border-radius:8px;
                font-size:14px;
                font-weight:700;
                text-decoration:none;
                margin-bottom:16px;
                box-shadow:0 4px 14px rgba(33,150,211,0.35);
              ">
                Install Syphir Shield →
              </a>

              <p style="color:#4a5568;font-size:11px;text-align:center;margin:0;">
                Only takes 30 seconds · Works on Chrome, Edge, and Brave
              </p>
            </div>

            <!-- Footer -->
            <div style="text-align:center;margin-top:24px;">
              <p style="color:#4a5568;font-size:11px;margin:0;">
                Syphir · AI Data Protection · 
                <a href="mailto:support@syphir.io" style="color:#4a5568;">support@syphir.io</a>
              </p>
            </div>

          </div>
        </body>
        </html>
      `,
    });

    console.log(`📧 Invite sent to ${employee_email} for ${org_name || org.name}`);
    return c.json({ success: true, message: `Invite sent to ${employee_email}` });

  } catch (err) {
    console.error("Email send error:", err);
    return c.json({ success: false, message: "Failed to send email" }, 500);
  }
});

console.log("🛡️  Syphir API running on http://localhost:3000");
export default { port: 3000, fetch: app.fetch };