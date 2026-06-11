# Server Endpoint Security

**Date**: 2026-02-22
**Status**: Draft
**Author**: AI-assisted
**Related**: ~~`20260222T195800-server-side-api-key-management.md`~~ (superseded: key store removed, see `20260223T102844-remove-key-store-simplify-api-key-resolution.md`)

> **Note (2026-02-23)**: The `/api/provider-keys` endpoints referenced in this spec have been removed along with the encrypted key store. API keys are now resolved from environment variables. The security model for auth, sync, and proxy endpoints still applies, but key management endpoints no longer exist.
>
> **Path note (2026-05-22):** The `~/.epicenter/server/config.json` examples are stale. Do not copy them into new local-server config or auth work.

## Overview

A two-layer security model for the Epicenter local server's HTTP endpoints. Layer 1: CORS origin allowlist (protects against browser-based attacks). Layer 2: bearer token authentication (protects against non-browser processes). Configurable via `~/.epicenter/server/config.json`.

## Motivation

### The Problem

The Epicenter server runs on `http://localhost:3913` and exposes sensitive endpoints:

- `PUT /api/provider-keys/:provider`: stores API keys worth real money
- `POST /ai/chat`: uses stored API keys to make billable API calls
- `DELETE /api/provider-keys/:provider`: removes API keys

**Any process on the user's machine can hit these endpoints.** This includes:

- A malicious browser extension running `fetch("http://localhost:3913/...")`
- A compromised npm package in any Node/Bun process
- A malicious website the user visits (CSRF via JavaScript)
- A rogue CLI tool or script

Without protection, an attacker doesn't need disk access or elevated privileges, just the ability to run code on the same machine.

### What CORS Does and Doesn't Do

CORS (Cross-Origin Resource Sharing) is a **browser-enforced** mechanism. When a browser makes a cross-origin request, it sends the `Origin` header and checks the server's `Access-Control-Allow-Origin` response header. If the origin isn't allowed, the browser blocks the response.

**CORS protects against:**

- Malicious websites making fetch requests to localhost
- Browser extensions operating in a web context
- Cross-origin iframe attacks

**CORS does NOT protect against:**

- Node.js/Bun/Python scripts (they don't send Origin headers or enforce CORS)
- curl, wget, or any HTTP client
- Native desktop apps making HTTP requests
- Compromised npm packages running in a build process

**Implication**: CORS is necessary but insufficient. A second layer is needed for non-browser clients.

### Ecosystem Requirement

Epicenter is designed as an ecosystem where multiple apps connect to the same server:

- Tauri desktop app (Whispering)
- Dev servers for different Epicenter apps
- CLI tools
- Future third-party integrations

The security model must support multiple legitimate clients while blocking unauthorized access.

## Design Decisions

| Decision                | Choice                              | Rationale                                                                            |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| Browser client auth     | CORS origin allowlist               | Browser enforces it. Zero client-side code needed. Standard.                         |
| Non-browser client auth | Bearer token from config file       | Simple, stateless, no handshake. Each app gets its own token.                        |
| Config storage          | `~/.epicenter/server/config.json`   | Same directory as `keys.db` and `master.key`. Single location for all server config. |
| Token generation        | Server auto-generates on first boot | Zero setup for single-app use. User adds more tokens for additional apps.            |
| Granularity             | Per-app tokens (not per-endpoint)   | Epicenter apps are trusted or not. Per-endpoint ACLs are premature complexity.       |
| Default origins         | `["tauri://localhost"]`             | Tauri webview is always a legitimate client. Dev servers added manually.             |

## Architecture

### Config File

```jsonc
// ~/.epicenter/server/config.json
{
	"allowedOrigins": [
		"tauri://localhost", // Tauri desktop app (always included)
		"http://localhost:5173", // Whispering dev server
		"http://localhost:5174", // Assistant dev server
	],
	"appKeys": [
		{
			"name": "cli",
			"key": "ek_cli_a1b2c3d4e5f6...",
		},
		{
			"name": "external-tool",
			"key": "ek_ext_x7y8z9...",
		},
	],
}
```

**`allowedOrigins`**: Array of origins that browser clients can make requests from. Checked against the `Origin` request header. If the request has an `Origin` header and it's not in this list → 403.

**`appKeys`**: Array of named bearer tokens for non-browser clients. Non-browser clients send `Authorization: Bearer ek_cli_a1b2c3d4e5f6...`. If a request has no `Origin` header and no valid bearer token → 401.

### Request Authentication Flow

```
  Incoming Request
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  Has Origin header?                         │
  │                                             │
  │  YES ──▶ Origin in allowedOrigins?          │
  │           │                                 │
  │           YES ──▶ ✅ Allow (set CORS headers)│
  │           NO  ──▶ ❌ 403 Forbidden          │
  │                                             │
  │  NO  ──▶ Has Authorization: Bearer header?  │
  │           │                                 │
  │           YES ──▶ Token in appKeys?         │
  │                   │                         │
  │                   YES ──▶ ✅ Allow          │
  │                   NO  ──▶ ❌ 401 Unauthorized│
  │           │                                 │
  │           NO  ──▶ ❌ 401 Unauthorized       │
  │                                             │
  └─────────────────────────────────────────────┘
```

### CORS Response Headers

For allowed origins, the server sets:

```
Access-Control-Allow-Origin: <matched origin>
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

Preflight `OPTIONS` requests are handled automatically: return 204 with CORS headers, no body.

### First Boot Behavior

1. Server checks for `~/.epicenter/server/config.json`
2. If missing → create with defaults:
   ```json
   {
	"allowedOrigins": ["tauri://localhost"],
	"appKeys": []
   }
   ```
3. No app keys by default: browser-only access works out of the box via CORS
4. User adds app keys manually when they want non-browser access (CLI tools, scripts)

### Token Format

App keys use the format: `ek_<name>_<random>` where:

- `ek_` prefix identifies it as an Epicenter key (easy to grep, easy to revoke)
- `<name>` is a short identifier (e.g., `cli`, `ext`)
- `<random>` is 32 bytes of `crypto.getRandomValues`, base62-encoded

Example: `ek_cli_7kR9mN2xPqL5vW8bF3jY6tH4cA1dG0eS`

A CLI command generates new keys:

```bash
# Add a new app key
bun run epicenter add-key --name "my-cli-tool"
# → Added key: ek_my-cli-tool_7kR9mN2xPqL5vW8bF3jY6tH4cA1dG0eS
# → Saved to ~/.epicenter/server/config.json
```

### What Gets Protected

| Endpoint Pattern                      | Auth Required? | Why                                     |
| ------------------------------------- | -------------- | --------------------------------------- |
| `PUT /api/provider-keys/:provider`    | ✅ Yes         | Writes sensitive API keys               |
| `GET /api/provider-keys`              | ✅ Yes         | Lists configured providers              |
| `DELETE /api/provider-keys/:provider` | ✅ Yes         | Removes API keys                        |
| `POST /ai/chat`                       | ✅ Yes         | Uses stored API keys for billable calls |
| `GET /health`                         | ❌ No          | Health check, no sensitive data         |
| `OPTIONS *`                           | ❌ No          | CORS preflight, must be unauthenticated |
| `GET /openapi`                        | ❌ No          | API documentation, public               |

### Rate Limiting (Safety Net)

As a defense-in-depth measure, sensitive endpoints have basic rate limiting:

| Endpoint                              | Limit       | Window     |
| ------------------------------------- | ----------- | ---------- |
| `PUT /api/provider-keys/:provider`    | 10 requests | per minute |
| `POST /ai/chat`                       | 60 requests | per minute |
| `DELETE /api/provider-keys/:provider` | 10 requests | per minute |

Rate limiting uses in-memory counters (no external dependency). Resets on server restart. This catches runaway scripts or accidental loops, not sophisticated attacks.

## Implementation Plan

### Phase 1: CORS + Bearer Token Middleware

- [ ] **1.1** Define config schema: `ServerSecurityConfig` type with `allowedOrigins: string[]` and `appKeys: { name: string; key: string }[]`
- [ ] **1.2** Config file management: read/write `~/.epicenter/server/config.json`, create with defaults on first boot
- [ ] **1.3** CORS middleware: check `Origin` header against `allowedOrigins`, set CORS response headers, handle OPTIONS preflight
- [ ] **1.4** Bearer token middleware: check `Authorization: Bearer <token>` against `appKeys` when no Origin header present
- [ ] **1.5** Compose middlewares: if request has Origin → CORS check; if no Origin → bearer check; endpoints listed as public skip both
- [ ] **1.6** Wire into `createServer()`: apply middleware to all routes except health/openapi/OPTIONS
- [ ] **1.7** Tests: allowed origin passes, disallowed origin blocked, valid token passes, invalid token blocked, no auth on public endpoints, OPTIONS preflight works

### Phase 2: Developer Tooling

- [ ] **2.1** CLI command: `bun run epicenter add-key --name <name>` generates token, appends to config
- [ ] **2.2** CLI command: `bun run epicenter list-keys` shows configured app keys (name only, not token)
- [ ] **2.3** CLI command: `bun run epicenter remove-key --name <name>` removes token from config
- [ ] **2.4** CLI command: `bun run epicenter add-origin <origin>` appends origin to allowlist

### Phase 3: Rate Limiting (future)

- [ ] **3.1** In-memory rate limiter with per-IP/per-token counters
- [ ] **3.2** Apply to sensitive endpoints per rate limit table above
- [ ] **3.3** Return `429 Too Many Requests` with `Retry-After` header

## Edge Cases

### Tauri Webview Origin

Tauri sends `tauri://localhost` as the Origin header. This is always in the default allowlist. If a user accidentally removes it, the desktop app stops working. The config file is user-editable, so they can fix it.

### Development Servers

Dev servers (Vite) use origins like `http://localhost:5173`. These must be manually added to `allowedOrigins`. This is intentional. We don't want to auto-allow all localhost ports.

### Config File Hot Reload

The server reads `config.json` on boot. Changes to the file require a server restart. Hot-reloading config adds complexity (file watchers, race conditions) for minimal benefit: config changes are rare.

### Multiple Servers

If multiple Epicenter server instances run on different ports, they share the same `config.json`. This is fine. The config is about "which clients are trusted", not "which server am I".

### Bearer Token in Browser

A browser client could technically send a bearer token instead of relying on CORS. This works. The middleware checks bearer first if present. But CORS is preferred for browser clients because it's automatic (no token management in the frontend).

## Prior Art

| Tool                | Local Server Auth     | How                                                |
| ------------------- | --------------------- | -------------------------------------------------- |
| **Ollama**          | CORS origin allowlist | `OLLAMA_ORIGINS` env var, default allows localhost |
| **Open WebUI**      | Session cookie + CORS | Full auth system, overkill for local               |
| **LM Studio**       | None                  | Binds to localhost only, no auth                   |
| **Cursor**          | Internal IPC          | Not HTTP-based                                     |
| **VS Code Copilot** | GitHub auth token     | Cloud-first, not local                             |

Epicenter's approach is closest to Ollama's CORS model, extended with bearer tokens for non-browser clients.

## Success Criteria

- [ ] Browser request from allowed origin succeeds
- [ ] Browser request from disallowed origin gets 403
- [ ] Non-browser request with valid bearer token succeeds
- [ ] Non-browser request without token gets 401
- [ ] Tauri desktop app works out of the box (no config needed)
- [ ] Adding a dev server origin requires one config edit + restart
- [ ] `bun test` in `packages/server` passes
- [ ] No new dependencies (CORS handling is trivial to implement, no middleware library needed)

## References

- `packages/server/src/server.ts`: `createServer()` where middleware will be wired
- `specs/20260222T195800-server-side-api-key-management.md`: API key endpoints this spec protects
- [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS): Canonical CORS reference
- [Ollama CORS config](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-allow-additional-web-origins-to-access-ollama): Prior art for local server CORS
