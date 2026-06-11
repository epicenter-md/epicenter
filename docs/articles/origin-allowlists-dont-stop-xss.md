# Origin Allowlists Are Not Enough and Don't Stop XSS

A common pattern for securing localhost servers is to check the `Origin` header and only allow requests from trusted domains. This feels secure. You're explicitly listing which sites can access your API.

It's not enough.

If any site on your allowlist gets XSS'd, the attacker's injected JavaScript runs with that site's origin. Your origin check passes. The attacker is in.

---

## The Setup

You're running a local server for your app. Maybe it's a dev tool, a personal API, or something like Epicenter that manages your data on `localhost:3913`. You want your web app to access it, but you don't want random websites hitting your localhost.

So you add origin checking:

```typescript
const ALLOWED_ORIGINS = ['http://localhost:3000', 'https://myapp.com'];

app.use((req, res, next) => {
	const origin = req.headers.origin;
	if (origin && !ALLOWED_ORIGINS.includes(origin)) {
		return res.status(403).json({ error: 'Origin not allowed' });
	}
	next();
});
```

Now only `localhost:3000` and `myapp.com` can hit your server. Random malicious sites are blocked. Secure, right?

---

## The Attack

Your app at `https://myapp.com` has an XSS vulnerability. Maybe it's a stored XSS in user comments, a reflected XSS in a search parameter, or a DOM-based XSS from improper sanitization.

An attacker exploits it and injects this script:

```javascript
// Attacker's payload, running on myapp.com
fetch('http://localhost:3913/workspaces/blog/deleteAllPosts', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
});
```

What happens?

1. The request goes to your localhost server
2. The `Origin` header is `https://myapp.com`
3. Your server checks: "Is myapp.com in the allowlist? Yes."
4. Request proceeds. All posts deleted.

**The origin check passed because the malicious code IS running on an allowed origin.**

---

## Why This Happens

The browser sets the `Origin` header automatically. You can't fake it from JavaScript. So checking Origin does prevent `evil.com` from directly hitting your localhost.

But XSS changes the game. When an attacker injects JavaScript into `myapp.com`, that code:

- Runs in the `myapp.com` origin
- Has access to `myapp.com`'s cookies and localStorage
- Sends requests with `Origin: https://myapp.com`

From the server's perspective, it looks exactly like a legitimate request from your app.

---

## A Concrete Example

Let's say you're building a local-first notes app. You have:

- A web UI at `http://localhost:3000`
- An Epicenter server at `http://localhost:3913`
- Origin allowlist: `['http://localhost:3000']`

Your web UI has a markdown preview feature that doesn't sanitize properly:

```javascript
// Vulnerable code in your app
notesContainer.innerHTML = marked(userNote);
```

An attacker creates a note with this content:

```markdown
# My Note

<img src="x" onerror="fetch('http://localhost:3913/deleteAllNotes',{method:'POST'})">
```

When anyone views this note:

1. The markdown renders, including the malicious `<img>` tag
2. The `onerror` handler fires (image fails to load)
3. `fetch()` sends a DELETE request to your localhost server
4. Origin header = `http://localhost:3000` (allowed!)
5. Your notes are gone

---

## What Origin Checking Actually Protects Against

Origin checking is not useless. It does protect against:

| Threat                               | Protected? |
| ------------------------------------ | ---------- |
| Random malicious website             | ✅ Yes     |
| Attacker who doesn't know your app   | ✅ Yes     |
| Broad, untargeted attacks            | ✅ Yes     |
| XSS on an allowed origin             | ❌ No      |
| Targeted attack on your specific app | ❌ No      |

It raises the bar. The attacker needs to find an XSS on a site you trust, not just any site. That's a smaller attack surface.

But it's not a security boundary. It's a speed bump.

---

## The Real Solution: Secrets

The only way to distinguish "legitimate request from your app" from "XSS payload running on your app" is something the XSS can't access.

**Options:**

### 1. Server-Side Secrets

Your web app's backend holds a secret. Browser JavaScript never sees it.

```
Browser → Your Backend (has secret) → Localhost Server
```

The attacker's XSS runs in the browser. It can't reach your backend's secret.

### 2. Local File Secrets

For CLI tools and scripts, store the secret in a file:

```bash
# .epicenter/auth-token
sec_abc123xyz789...
```

```bash
curl -H "Authorization: Bearer $(cat .epicenter/auth-token)" \
  http://localhost:3913/api/notes
```

Browser JavaScript can't read local files. Only processes running on your machine can.

### 3. Hardware-Bound Secrets

For maximum security, use hardware tokens (YubiKey, TPM) or OS keychain. Even if your machine is compromised, the secret can't be extracted.

---

## The Mental Model

Think of it this way:

| Factor               | Can XSS Access?    | Security Value |
| -------------------- | ------------------ | -------------- |
| Origin header        | ✅ Yes (automatic) | Low            |
| Cookies (same-site)  | ✅ Yes             | Low            |
| LocalStorage         | ✅ Yes             | Low            |
| JavaScript variables | ✅ Yes             | None           |
| Server-side env vars | ❌ No              | High           |
| Local files          | ❌ No              | High           |
| Hardware tokens      | ❌ No              | Highest        |

**If the browser can access it, XSS can access it.**

---

## Practical Recommendations

### For localhost dev servers:

1. Don't rely solely on origin checking
2. Generate a random token on startup
3. Require that token in an `Authorization` header
4. Store the token in a file that only local processes can read

### For production APIs:

1. Use proper authentication (OAuth, API keys)
2. Keep secrets server-side
3. Implement rate limiting and logging
4. Use CSP headers to reduce XSS risk

### For your web app:

1. Sanitize all user input (prevent XSS in the first place)
2. Use Content-Security-Policy headers
3. Don't put secrets in client-side JavaScript
4. Proxy sensitive requests through your backend

---

## The Uncomfortable Reality

XSS is everywhere. The average web app has vulnerabilities you haven't found yet. If your security model assumes "my allowed origins will never be XSS'd," you're one bug away from a breach.

Origin checking is a useful layer, but it's not a wall. It's a filter that catches opportunistic attacks while letting targeted attacks through.

For anything that matters, require a secret that JavaScript can't access.

---

## Summary

| Approach                    | Stops Random Sites | Stops XSS |
| --------------------------- | ------------------ | --------- |
| No protection               | ❌                 | ❌        |
| Origin allowlist only       | ✅                 | ❌        |
| Origin + client-side token  | ✅                 | ❌        |
| Origin + server-side secret | ✅                 | ✅        |
| Server-side secret only     | ✅                 | ✅        |

The origin check is redundant once you have server-side secrets. Keep it for defense-in-depth and audit logging, but don't trust it as your security boundary.

---

## Update: OpenCode Learned This the Hard Way

After [CVE-2026-22812](https://github.com/anomalyco/opencode/security/advisories/GHSA-vxw4-wv6m-9hhh), OpenCode moved from `CORS: *` to an origin allowlist (`localhost`, `*.opencode.ai`). They also added a server-side secret (`OPENCODE_SERVER_PASSWORD`) for HTTP Basic Auth. Exactly the pattern this article recommends. The wildcard `*.opencode.ai` in their allowlist is still a risk if any subdomain gets XSS'd, but the server-side secret is the real security boundary now. Full story: [OpenCode Got an RCE and I Already Wrote the Exploit](./opencode-rce-called-it.md).
