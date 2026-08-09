# @epicenter/sync

The store transport's connect URL, and the WebSocket subprotocol auth every
Epicenter upgrade uses. Both halves need them and only one of them is a server:
a browser replica builds the same URL and has no business importing Hono to
learn what path to ask for.

A browser `WebSocket` cannot set request headers, so a bearer credential rides
the subprotocol list instead. The client offers the main subprotocol plus
`bearer.<token>`; the server extracts the token, authenticates it, and echoes
back only the main subprotocol.

## Installation

Inside this monorepo:

```json
{
  "dependencies": {
    "@epicenter/sync": "workspace:*"
  }
}
```

The package has no runtime dependencies.

## Usage

```typescript
import {
  BEARER_SUBPROTOCOL_PREFIX,
  MAIN_SUBPROTOCOL,
  parseSubprotocols,
} from "@epicenter/sync";

// Client: offer the main subprotocol plus the credential.
new WebSocket(url, [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`]);

// Server: read the offer, then echo back only the main subprotocol.
const { main, bearer } = parseSubprotocols(
  request.headers.get("sec-websocket-protocol"),
);
```

`isOpenWebSocketDenial` classifies a rejected upgrade so a client can tell an
auth refusal from a transport failure.

`STORE_SYNC_ROUTE` is where a replica connects:

```typescript
import { STORE_SYNC_ROUTE } from "@epicenter/sync";

new WebSocket(
  STORE_SYNC_ROUTE.url(baseURL, { namespace, cursor }),
  STORE_SYNC_ROUTE.subprotocols(token),
);
```

One path (`/api/store/v1/sync`), and the addressing lives in the query: a
replica says which application namespace it is syncing and how far through the
log it has read. Whose data that is comes from the resolved bearer,
server-side, so there is no value a client can put in the query that reaches
another partition (ADR-0092, ADR-0225). `LENS_NAMESPACE` is the namespace
grammar both halves check against one definition.

## Scope

This package carries no Yjs, no document framing, and no transport. It is the
addressing and the handshake, and nothing that speaks over them: the rules about
who has been sent what live in `@epicenter/data/sync`, and the mount that
answers this route lives in `packages/server/src/store-sync/`.

## License

MIT. See [LICENSE](./LICENSE).
