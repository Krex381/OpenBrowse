# Browserless compatibility

OpenBrowse supports a practical self-hosted subset of Browserless-style
workflows. Compatibility aliases are intended for migration; OpenBrowse's
native `/v1` API and OpenAPI document are the primary interface.

| Capability | Availability | Notes |
|---|---|---|
| Browser pool, queue, recovery | Available | Bounded Chromium pool with memory admission and recycling. |
| REST content and media | Available | Content, scrape, screenshot, PDF, SVG, export, download, map, crawl, and search. |
| Typed browser workflows | Available | Bounded wait, click, fill, press, and extract steps; no caller-supplied JavaScript. |
| Sessions and profiles | Available | API-key-owned sessions, encrypted persistent state, profiles, traces, artifacts, and recordings. |
| BrowserQL and MCP | Available | Authenticated BrowserQL and Streamable HTTP MCP endpoints. |
| VNC viewer and human challenge handoff | Available in Docker | Session-scoped noVNC bridge, atomic `startUrl`, challenge status polling, and bounded resume preserve the exact BrowserContext. Alternative operator-default backends can run headed in Xvfb. |
| CDP and Playwright bridges | Operator opt-in | Disabled by default. Enable only behind a dedicated egress boundary. |
| Lighthouse | Operator opt-in | The bounded performance report is always available; full Lighthouse requires an isolated worker. |
| Proxy support | Available | Encrypted user-managed HTTP(S) proxies and domain allowlists. |
| Challenge-aware browser fallback | Available | A detected challenge can retry once through enabled Patchright, Clearcote, Camoufox, and CloakBrowser backends. Results expose the attempted backends and whether the challenge remains. |
| Raw fingerprint and humanization controls | Operator backends | Bounded `--fingerprint*` arguments apply to CloakBrowser/Clearcote; typed Camoufox options and Cloak humanization remain operator-controlled. |
| External CAPTCHA solving | Not provided | OpenBrowse does not submit challenges to a solving service or claim success when a challenge remains. Authorized operators can complete a challenge through the authenticated live session. |
| Managed cloud operations | Not provided | Billing, regions, managed proxy networks, and commercial support are operator concerns. |

## Authentication

Use `Authorization: Bearer <key>` for native API routes. Browserless migration
aliases accept `?token=<key>`. The VNC WebSocket also accepts a query token
because browser WebSocket clients cannot attach an Authorization header.

## Docker verification

On a Linux host with Docker:

```bash
export OPENBROWSE_API_KEYS='dev-key'
export OPENBROWSE_ENCRYPTION_KEY="$(openssl rand -base64 48)"
docker compose up -d --build
npm run verify:docker
```

Expected output:

```json
{"vnc":"RFB handshake verified","rawBridge":"disabled by operator policy"}
```

For a deliberate raw-browser-bridge test, recreate the service with
`OPENBROWSE_RAW_BROWSER_PROTOCOL_BRIDGES=true`, then run the verifier with
`OPENBROWSE_VERIFY_RAW_BRIDGES=true`. Return the service to its default
configuration afterwards.
