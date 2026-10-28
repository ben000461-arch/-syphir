#!/usr/bin/env python3
"""
remove_admin_compose_email.py

Cleanly removes the "Compose Email" admin panel tool added earlier
tonight - Ben decided to just use Gmail directly with
cooptech126@gmail.com for outreach instead, no need to maintain a
second interface for it. This is the exact reverse of
add_admin_compose_email.py - removes the /admin/send-email endpoint
and the Compose Email UI section + its JS function, leaving everything
else on the page untouched.

Usage:
    cd /path/to/-syphir     # repo root
    python3 remove_admin_compose_email.py
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SERVER_JS = REPO_ROOT / "api" / "server.js"
ADMIN_HTML = REPO_ROOT / "dashboard" / "bh7x29mq-admin.html"

SERVER_TO_REMOVE = '''// \u2500\u2500 ADMIN: COMPOSE & SEND EMAIL \u2500\u2500 outreach tool, sends from the real co|op
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

SERVER_REPLACEMENT = '''app.post("/admin/create-org", async (c) => {'''

HTML_TO_REMOVE = '''    <div id="addErr" style="color:var(--danger); font-size:0.82rem; margin-top:0.5rem; display:none;"></div>
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

HTML_REPLACEMENT = '''    <div id="addErr" style="color:var(--danger); font-size:0.82rem; margin-top:0.5rem; display:none;"></div>
  </div>

  <!-- Business Table -->'''

JS_TO_REMOVE = '''async function sendComposeEmail() {
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

JS_REPLACEMENT = '''async function addBusiness() {'''


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def remove(path, pairs, label):
    if not path.exists():
        fail(f"{path} not found")
    content = path.read_text(encoding="utf-8")
    for old, new in pairs:
        found = content.count(old)
        if found != 1:
            fail(f"[{label}] Expected 1 match to remove, found {found}. File may have changed since add_admin_compose_email.py ran.")
    for old, new in pairs:
        content = content.replace(old, new)
    path.write_text(content, encoding="utf-8")
    print(f"\u2713 {path.relative_to(REPO_ROOT)} reverted")


def main():
    print("co|op: remove admin panel compose-email tool\n")
    remove(SERVER_JS, [(SERVER_TO_REMOVE, SERVER_REPLACEMENT)], "server.js")
    remove(ADMIN_HTML, [(HTML_TO_REMOVE, HTML_REPLACEMENT), (JS_TO_REMOVE, JS_REPLACEMENT)], "admin.html")

    print("\n\u2705 Done. Nothing was committed or pushed.")
    print("Next: git diff, then commit/push yourself.")


if __name__ == "__main__":
    main()
