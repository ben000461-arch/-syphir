import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();
const SCANNER_URL = "http://localhost:8080";
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

console.log("🛡️  Syphir API running on http://localhost:3000");
export default { port: 3000, fetch: app.fetch };