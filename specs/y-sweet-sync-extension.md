# Y-Sweet Sync Extension

## Overview

Replace the existing `websocketSync` extension with a Y-Sweet-based sync extension that supports two modes:
- **Direct mode**: Connect directly to a Y-Sweet server (local dev, Tailscale)
- **Authenticated mode**: Connect via backend auth endpoint (hosted infrastructure)

## Background

Y-Sweet is a Yjs sync and persistence service by Jamsocket that provides:
- WebSocket-based real-time sync
- Built-in IndexedDB persistence for offline support
- Token-based authentication
- Automatic reconnection

### Why Y-Sweet over y-websocket?

| Feature | y-websocket | Y-Sweet |
|---------|-------------|---------|
| Real-time sync | ✓ | ✓ |
| Offline support | Requires y-indexeddb | Built-in |
| Authentication | Manual | Built-in tokens |
| Reconnection | Manual | Automatic |
| Hosted option | No | Yes (Jamsocket) |

## API Design

```typescript
type YSweetSyncConfig =
  | {
      mode: 'direct';
      /** Y-Sweet server URL (e.g., 'http://localhost:8080') */
      serverUrl: string;
    }
  | {
      mode: 'authenticated';
      /**
       * Auth endpoint that returns a ClientToken.
       * - String URL: Extension POSTs to get token
       * - Async function: Custom auth logic
       */
      authEndpoint: string | (() => Promise<YSweetClientToken>);
    };
```

The document ID is automatically derived from the workspace ID (`ydoc.guid`).
For offline persistence, use `y-indexeddb` alongside this extension.

### Usage Examples

```typescript
// Direct mode - local development
sync: ySweetSync({
  mode: 'direct',
  serverUrl: 'http://localhost:8080',
})

// Direct mode - Tailscale network
sync: ySweetSync({
  mode: 'direct',
  serverUrl: 'http://my-server.tailnet:8080',
})

// Authenticated mode - hosted infrastructure
sync: ySweetSync({
  mode: 'authenticated',
  authEndpoint: async () => {
    const token = await getStoredAuthToken();
    const res = await fetch('https://api.epicenter.app/y-sweet/auth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json(); // Backend returns ClientToken with namespaced docId
  },
})
```

## Implementation

### Direct Mode

Constructs a ClientToken from the server URL:

```typescript
function createDirectClientToken(serverUrl: string, docId: string): YSweetClientToken {
  const url = new URL(serverUrl);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return {
    url: `${wsProtocol}//${url.host}/d/${docId}/ws`,
    baseUrl: `${url.protocol}//${url.host}`,
    docId,
    token: undefined, // No auth for direct mode
  };
}
```

### Authenticated Mode

Calls the auth endpoint to get a ClientToken:

```typescript
// If authEndpoint is a string URL, POST to it
// If authEndpoint is a function, call it directly
const clientToken = typeof authEndpoint === 'string'
  ? await fetch(authEndpoint, { method: 'POST', ... }).then(r => r.json())
  : await authEndpoint();
```

### Auth Flow (Authenticated Mode)

See: [Extension Authentication Specification](./extension-authentication.md) (TODO)

```
Extension                    Your Backend                 Y-Sweet Server
────────                    ────────────                 ──────────────
    │                            │                            │
    │ POST /api/y-sweet/auth     │                            │
    │ + Bearer {session_token}   │                            │
    │ + { docId: "tab-manager" } │                            │
    │ ─────────────────────────→ │                            │
    │                            │ Validate session           │
    │                            │ Get userId                 │
    │                            │ Build: {userId}:tab-manager│
    │                            │                            │
    │                            │ POST /doc/{docId}/auth     │
    │                            │ + ServerToken              │
    │                            │ ─────────────────────────→ │
    │                            │                            │
    │                            │ ←───────────────────────── │
    │                            │ ClientToken                │
    │                            │                            │
    │ ←───────────────────────── │                            │
    │ ClientToken                │                            │
    │                            │                            │
    │ WebSocket connect ───────────────────────────────────→ │
    │ + ClientToken              │                            │
```

## Y-Sweet Server Setup

### Local Development

```bash
# In-memory storage (data lost on restart)
npx y-sweet@latest serve

# Persistent storage
npx y-sweet@latest serve ./data
```

Server runs at `http://127.0.0.1:8080` by default.

### Production (with auth)

```bash
# Generate auth key
npx y-sweet@latest gen-key

# Run with auth
npx y-sweet@latest serve --auth <auth-key> ./data
```

## Files to Modify

- `packages/epicenter/src/extensions/y-sweet-sync.ts` - Refactor to unified two-mode API
- `packages/epicenter/package.json` - Add `@y-sweet/client` dependency (already added)
- `apps/tab-manager/src/entrypoints/background.ts` - Use new API

## Testing

1. **Direct mode**: Start local Y-Sweet server, verify sync works
2. **Offline support**: Disconnect network, verify local persistence works
3. **Reconnection**: Kill server, restart, verify auto-reconnect
4. **Authenticated mode**: (Future) Test with mock auth endpoint

## Status

- [x] Initial Y-Sweet extension created
- [x] Refactor to unified two-mode API (direct + authenticated)
- [x] Update tab-manager to use new API
- [ ] Test direct mode with local Y-Sweet server
- [ ] Authenticated mode backend implementation (see extension-authentication.md)

## Notes

The Y-Sweet client (`@y-sweet/client` v0.6.4) does not include built-in IndexedDB persistence.
For offline support, use `y-indexeddb` alongside the Y-Sweet sync extension.

```typescript
const client = createWorkspace(definition).withExtensions({
  persistence: ({ ydoc }) => {
    const provider = new IndexeddbPersistence('my-doc', ydoc);
    return defineExports({
      provider,
      whenSynced: provider.whenSynced,
      destroy: () => provider.destroy(),
    });
  },
  sync: ySweetSync({
    mode: 'direct',
    serverUrl: 'http://localhost:8080',
  }),
});
```
