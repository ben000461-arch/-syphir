#!/usr/bin/env python3
"""
add_admin_compose_email.py

Adds a "Compose Email" tool to the admin panel - lets you write and
send a real email from co|op's own domain (hello@co-optech.com, replies
to cooptech126@gmail.com) to any address, directly from the dashboard.
This is the outreach tool - email a prospect, a business, anyone -
without leaving the admin panel or switching to Gmail.

Backend: new POST /admin/send-email endpoint, protected by the same
requireAdmin() check every other admin route uses. Rate-limited the
same way /contact is (5/min) as basic defense in depth, even though
it's already admin-gated.

Frontend: new section in the admin panel, right after "Add New
Business" - To / Subject / Message fields, a Send button, matching the
exact visual style and JS patterns (apiFetch, _adminSecret, showToast)
already used by addBusiness() elsewhere on the same page.

Usage:
    cd /path/to/-syphir     # repo root
    python3 add_admin_compose_email.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"
ADMIN_HTML = REPO_ROOT / "dashboard" / "bh7x29mq-admin.html"

# ── server.js: new endpoint ─────────────────────────────────────────────────

SERVER_OLD = '''app.post("/admin/create-org", async (c) => {'''

SERVER_NEW = '''// \u2500\u2500 ADMIN: COMPOSE & SEND EMAIL \u2500\u2500 outreach tool, sends from the real co|op
// domain via Resend to any address the admin types in.
app.post("/admin/send-email", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
  if (isRateLimited(c, "admin-send-email", 15, 60_000)) return c.json({ error: "Too many emails sent. Slow down." }, 429);

  const { to, subject, message } = await c.req.json().catch(() => ({}));
  if (!to || !to.includes("@")) return c.json({ error: "Valid recipient email required" }, 400);
  if (!subject || !subject.trim()) return c.json({ error: "Subject required" }, 400);
  if (!message || !message.trim()) return c.json({ error: "Message required" }, 400);

  const safeMessage = message
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  try {
    await resend.emails.send({
      from: EMAIL_FROM, replyTo: EMAIL_REPLYTO, to: to.trim(), subject: subject.trim(),
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a2e;">
          <div style="font-size:20px;font-weight:700;margin-bottom:20px;">co|op</div>
          <div style="white-space:pre-wrap;line-height:1.6;color:#333;font-size:15px;">${safeMessage}</div>
        </div>
      `,
    });
    console.log(`[Admin] Email sent to ${to}: "${subject}"`);
    return c.json({ success: true });
  } catch (err) {
    console.error("[Admin] send-email failed:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

app.post("/admin/create-org", async (c) => {'''

# ── admin.html: new UI section ──────────────────────────────────────────────

HTML_OLD = '''    <div id="addErr" style="color:var(--danger); font-size:0.82rem; margin-top:0.5rem; display:none;"></div>
  </div>

  <!-- Business Table -->'''

HTML_NEW = '''    <div id="addErr" style="color:var(--danger); font-size:0.82rem; margin-top:0.5rem; display:none;"></div>
  </div>

  <!-- Compose Email -->
  <div class="add-biz-form" style="margin-top:2rem;">
    <h3>Compose Email</h3>
    <p style="color:var(--muted); font-size:0.82rem; margin-bottom:1rem; margin-top:-0.3rem;">Sends from hello@co-optech.com, replies land at cooptech126@gmail.com.</p>
    <div class="form-row">
      <div>
        <label style="display:block; font-size:0.75rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:0.35rem;">To</label>
        <input class="form-input" id="composeTo" type="email" placeholder="someone@theirbusiness.com">
      </div>
      <div>
        <label style="display:block; font-size:0.75rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:0.35rem;">Subject</label>
        <input class="form-input" id="composeSubject" placeholder="Quick question about your data protection">
      </div>
    </div>
    <div class="form-row">
      <div style="grid-column: 1 / -1;">
        <label style="display:block; font-size:0.75rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:0.35rem;">Message</label>
        <textarea class="form-input" id="composeMessage" rows="6" style="resize:vertical; font-family:inherit;" placeholder="Write your message..."></textarea>
      </div>
    </div>
    <button class="add-btn" onclick="sendComposeEmail()" id="composeBtn" style="width:100%;">Send Email</button>
    <div id="composeErr" style="color:var(--danger); font-size:0.82rem; margin-top:0.5rem; display:none;"></div>
  </div>

  <!-- Business Table -->'''

# ── admin.html: new JS function, inserted right before addBusiness() ────────

JS_OLD = '''async function addBusiness() {'''

JS_NEW = '''async function sendComposeEmail() {
  const to      = document.getElementById('composeTo').value.trim();
  const subject = document.getElementById('composeSubject').value.trim();
  const message = document.getElementById('composeMessage').value.trim();
  const err     = document.getElementById('composeErr');

  if (!to || !to.includes('@')) { err.textContent = 'Enter a valid recipient email.'; err.style.display = 'block'; return; }
  if (!subject) { err.textContent = 'Subject is required.'; err.style.display = 'block'; return; }
  if (!message) { err.textContent = 'Message is required.'; err.style.display = 'block'; return; }
  err.style.display = 'none';

  const btn = document.getElementById('composeBtn');
  btn.textContent = 'Sending\u2026';
  btn.disabled = true;

  try {
    const res = await apiFetch(`${API}/admin/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': _adminSecret },
      body: JSON.stringify({ to, subject, message })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      err.textContent = data.error || 'Failed to send email.';
      err.style.display = 'block';
      return;
    }
    document.getElementById('composeTo').value = '';
    document.getElementById('composeSubject').value = '';
    document.getElementById('composeMessage').value = '';
    showToast('\u2713 Email sent to ' + to);
  } catch(e) {
    err.textContent = 'API error: ' + e.message;
    err.style.display = 'block';
  } finally {
    btn.textContent = 'Send Email';
    btn.disabled = false;
  }
}

async function addBusiness() {'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def apply(path, replacements, label):
    if not path.exists():
        fail(f"{path} not found")
    content = path.read_text(encoding="utf-8")
    for old, new in replacements:
        found = content.count(old)
        if found != 1:
            fail(f"[{label}] Expected 1 match (starting {old[:60]!r}...), found {found}. File may have changed.")
    for old, new in replacements:
        content = content.replace(old, new)
    path.write_text(content, encoding="utf-8")
    print(f"\u2713 {path.relative_to(REPO_ROOT)} updated")


def main():
    print("co|op: add admin panel compose-email tool\n")
    apply(SERVER_JS, [(SERVER_OLD, SERVER_NEW)], "server.js")
    apply(ADMIN_HTML, [(HTML_OLD, HTML_NEW), (JS_OLD, JS_NEW)], "admin.html")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("\nNext: git diff, then commit/push yourself.")
    print("\nOnce live: open the admin panel, you'll see a 'Compose Email' box right")
    print("under 'Add New Business' - type a recipient, subject, and message, hit Send.")


if __name__ == "__main__":
    main()
