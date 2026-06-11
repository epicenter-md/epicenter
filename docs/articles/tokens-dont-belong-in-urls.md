# Tokens Don't Belong in URLs

Our WebSocket auth used to look like this:

```ts
const ws = new WebSocket(`wss://api.epicenter.so/docs/${docId}?token=${sessionToken}`);
```

Simple, works everywhere, every Epicenter client shipped with this for months. Then I was reading through Cloudflare's default log fields and realized something unpleasant: the full URL, including the query string, lands in access logs by default. Which means every session token we'd ever used in the browser was sitting in a log pipeline somewhere, readable by anyone with log access, valid until the session expired.

Better Auth sessions default to seven days. Cloudflare Logpush retention is whatever you configured. If you shipped logs to Datadog or Sentry, add their retention on top. A token that should have been a transient handshake credential was accidentally a seven-day bearer key floating in three different observability systems.

## The fix is a standard, I just hadn't seen it

You can't set `Authorization` on a browser WebSocket. The browser `WebSocket` constructor takes a URL and an optional list of subprotocols, and that's it. No headers, no custom fields. So the token has to ride along on one of those two inputs. URL or subprotocol.

Subprotocols are meant for negotiating what goes over the wire after the handshake. Like `graphql-transport-ws` or `mqtt`. But the `Sec-WebSocket-Protocol` header is just a comma-separated list of ASCII tokens, and nobody checks what you put in there as long as the server echoes back one of them to complete the 101 handshake. So you can smuggle auth through it.

Here's what we do now:

```ts
const ws = new WebSocket(wsUrl, ['epicenter', `bearer.${token}`]);
```

The client offers two protocols. `epicenter` is the real one the server echoes back. `bearer.<token>` is a carrier. The server reads it, consumes it, and never echoes it. The token lives in a header, not a URL, and headers don't get logged by default on Cloudflare or most HTTP middlewares.

On the server, it's a few lines:

```ts
function withBearerFromSubprotocol(original: Headers): Headers {
    const offered = original.get('sec-websocket-protocol');
    if (!offered) return original;

    const bearer = offered
        .split(',')
        .map((s) => s.trim())
        .find((s) => s.startsWith('bearer.'));
    if (!bearer) return original;

    const next = new Headers(original);
    next.set('authorization', `Bearer ${bearer.slice('bearer.'.length)}`);
    return next;
}
```

We extract the `bearer.<token>` entry, synthesize a standard `Authorization: Bearer <token>` header, and hand it to Better Auth's `getSession`. From Better Auth's perspective, it looks exactly like an HTTP request with a bearer header, which is what its bearer plugin was already built to handle. No new auth code, just a bridge.

## Why this pattern exists

I felt smart about the subprotocol trick for about ten minutes before realizing it's the exact pattern Kubernetes uses for its API server. Their subprotocol string is `base64url.bearer.authorization.k8s.io.<base64url-encoded-token>`: longer, more namespaced, but structurally identical. Supabase Realtime does the same thing with `phx_bearer.<token>`. Phoenix channels, OpenShift, a handful of others. This is a standard move; I just hadn't seen it.

The reason everyone converges here is that the alternatives are worse:

- **Query string**: the leak we just talked about.
- **Cookies only**: works for same-origin browsers, breaks every CLI and headless client.
- **Auth message after connect**: creates a race where the server has accepted the socket but doesn't know who you are yet. Every bit of server logic has to special-case the pre-auth state. No thanks.
- **Short-lived JWT in query string**: defensible if the JWT expires in under a minute, which is what Firebase and Liveblocks do. Requires a token-minting endpoint and TTL management. More moving parts.

Subprotocol auth runs during the handshake. By the time the server writes the 101 response, the token's been validated and we know who the user is. No pre-auth state, no extra round-trip, no TTL to manage.

## What I should have thought about sooner

The thing that bugs me about the old `?token=` version isn't that it was insecure. Cloudflare logs aren't publicly readable and our session tokens were scoped to our own API. It's that I never asked where the URL ended up. I wrote `new URL(wsUrl).searchParams.set('token', token)` and moved on. The token existed, the request worked, I checked it off.

The question I should have asked: *after this URL is constructed, who sees it?* Cloudflare sees it. Our access logs see it. If a user ever pasted a WebSocket URL into a bug report, GitHub saw it. If we forwarded headers anywhere for debugging, the downstream service saw it. A URL is a public surface. Treating it like private transport is a category error.

Subprotocols aren't magically private either. If you turn on `RequestHeaders` capture in Cloudflare Logpush, the `Sec-WebSocket-Protocol` header shows up too. But it's off by default, and nothing treats it like a canonical identifier the way URLs get treated. It's private enough for this use case, and a lot more private than URL-space by default.

The real lesson: every credential I put anywhere, I should be able to answer "what logs, caches, and referrers does this touch?" If I can't answer that in ten seconds, I haven't thought about it enough.

## If you want to do this in your own server

The client side is one line:

```ts
new WebSocket(url, ['your-app-protocol', `bearer.${token}`]);
```

The server side needs to do two things: read the bearer from the `Sec-WebSocket-Protocol` header and validate it, then echo back the non-bearer protocol in the 101 response so the browser accepts the handshake. If you don't echo something the client offered, the browser errors out with "server sent invalid subprotocol" and the connection never opens. On Cloudflare Workers with Durable Objects:

```ts
const pair = new WebSocketPair();
const responseHeaders = new Headers();
const offered = request.headers.get('sec-websocket-protocol');
if (offered?.split(',').map((s) => s.trim()).includes('your-app-protocol')) {
    responseHeaders.set('sec-websocket-protocol', 'your-app-protocol');
}
return new Response(null, { status: 101, webSocket: pair[0], headers: responseHeaders });
```

That's the whole trick. Two lines on the client, a prefix extraction on the server, and a protocol echo on the upgrade response. If you want to see it in context, the Epicenter code is here: [app.ts](https://github.com/braden-w/epicenter/blob/main/apps/api/src/app.ts) and [room.ts](https://github.com/braden-w/epicenter/blob/main/apps/api/src/room.ts). Fork it, adapt it, ship your own version.
