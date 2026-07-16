---
name: server.js Render safe startup rules
description: Rules for api/server.js to prevent Render deploy crashes from top-level throws or missing env var fallbacks
type: feedback
---

Never use `throw` at the top level of api/server.js. Render injects env vars after module load, so any top-level throw will crash every deploy.

**Why:** Adding `if (!ADMIN_SECRET) throw new Error(...)` at the top level caused 3 consecutive failed Render deploys and broke the live API for all users.

**How to apply:**
- All env var reads must use `|| ''` fallback: `process.env.VAR_NAME || ''`
- Missing env vars: use `console.warn()` only, never `throw`
- Throws are only allowed inside functions or route handlers
- Before committing any server.js change, check: does any code outside a function body throw or crash?
- Verify with: `grep -n "throw new Error" api/server.js` — all results must be inside function bodies
