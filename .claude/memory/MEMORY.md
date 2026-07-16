# Memory Index

- [server.js Render safe startup rules](feedback_server_js_render_safety.md) — Never throw at top level of server.js; use || '' fallbacks on all env vars; Render deploys crash if top-level code throws
