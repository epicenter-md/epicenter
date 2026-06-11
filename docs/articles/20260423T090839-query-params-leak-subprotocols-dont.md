# Query Params Leak. Subprotocols Don't.

For a while, our WebSocket client smuggled the auth token in the URL:

```ts
const ws = new WebSocket(`wss://api.epicenter.so/workspaces/${id}?token=${token}`);
```

It worked. Every code path with a token appended it as a query param, the server parsed it on upgrade, session established. Straightforward.

Then I started reading where URLs actually end up.

## URLs are not ephemeral

A URL looks like a one-shot thing. It's the target of a single request, then it's gone. It isn't. A URL with a query string gets persisted and forwarded to surprisingly many places:

- **Cloudflare access logs.** Every request's full URL lands in R2 as structured log data, retained per our plan.
- **Browser history.** Chrome saves the URL of any `new WebSocket(...)` in its site data, searchable by anyone with the profile.
- **Referrer headers.** If the app later navigates to a different origin, the browser sends the previous URL as `Referer:`. That URL contains the token.
- **CDN edge caches.** Even for WebSocket upgrades, some edge layers log the handshake URL.
- **Proxy logs.** Any HTTP proxy in the path (corporate middleboxes, debugging tools like Charles) sees the token in plaintext even over TLS, because the URL travels in the `GET /path?token=...` line of the request, and a proxy decrypting for inspection will log it.
- **Bug reports.** When a user screenshots their dev tools to show you a failing request, the token is right there in the URL bar.

None of this is a bug in any one system. Query strings are *designed* to be visible. They're part of the URL, and URLs are part of the web's address space, so they get indexed, logged, and shared. The token showing up in all those places is the system working correctly. The mistake was putting a credential in a field that's treated as public.

## The subprotocol header doesn't leak

WebSocket handshakes have a header the URL doesn't: `Sec-WebSocket-Protocol`. It's meant to negotiate the application protocol a server speaks: `mqtt`, `graphql-ws`, `xmpp`, whatever. The client offers a comma-separated list of protocols; the server picks one and echoes it on the 101 response.

Nothing in the spec requires the offered protocols to be single words. They can be anything in the RFC 7230 `token` character set, which includes dots and alphanumerics. So you can do this:

```ts
const ws = new WebSocket(wsUrl, ['epicenter', `bearer.${token}`]);
```

To the server, this is a client offering two protocols. On upgrade, the server reads `bearer.<token>` out of the `Sec-WebSocket-Protocol` header, extracts the token, validates it, and echoes only `epicenter` back on the 101. The client sees the server picked `epicenter`. The token entry was a carrier: one-way, consumed on the handshake, never echoed.

The subprotocol header goes exactly one place: in the HTTP request line of the WebSocket handshake, as a header. It is:

- **Not logged by default.** Cloudflare logs URL + status + bytes, not arbitrary headers. Same for most access log formats. You'd have to explicitly opt in.
- **Not in browser history.** History stores URLs, not handshake headers.
- **Not in `Referer:`.** That field carries the URL, and only the URL.
- **Not in CDN caches.** WebSocket upgrades aren't cacheable.
- **Not in bug-report screenshots.** The dev tools Network tab shows the handshake with headers, but it's one click deeper than the URL bar.

Moving the token from `?token=...` to `Sec-WebSocket-Protocol: bearer.<token>` doesn't eliminate every path a token could leak through. A stolen laptop with an unlocked devtools inspector still exposes it. But it closes the passive-logging paths, which are the ones you can't retroactively audit.

## Why the dot

I wanted to write `bearer:<token>` because that's what the `Authorization: Bearer <token>` header uses. Can't. `:` isn't a valid `tchar` per RFC 7230, so a strict proxy could reject the handshake. Dots are fine. Kubernetes uses `base64url.bearer.authorization.k8s.io.<token>` for the same reason. Hasura uses `bearer.<jwt>`. The dot is the convention because the spec forbids the more obvious separators.

## What this doesn't fix

**If you XSS the app, you still lose.** Subprotocol auth doesn't help against attackers who can run JavaScript in your origin: they just call `localStorage.getItem('token')` and open their own WebSocket. Bearer-in-header vs bearer-in-URL is a passive-logging defense, not an active-exfiltration defense. For that, you need httpOnly cookies, and httpOnly cookies are why native apps and extensions use bearer tokens in the first place (see [Why Epicenter Uses Bearer Tokens Everywhere](why-epicenter-uses-bearer-tokens-everywhere.md)).

**If you already shipped the query-param version, rotate tokens.** Anything that was sent as `?token=` before the switch might still be in a log somewhere. Short session TTLs + refresh tokens are the cleanup.

## One rule

If it goes in the URL, assume it shows up in a log. If it goes in a header, especially one that isn't routed through a cache or a log pipeline. It mostly doesn't.

For auth tokens, "mostly doesn't" is the upgrade.
