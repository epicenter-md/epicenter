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
  bearerSubprotocol,
  MAIN_SUBPROTOCOL,
  parseSubprotocols,
  STORE_SYNC_ROUTE,
} from "@epicenter/sync";

// Route: the URL and the main subprotocol, as one value.
const address = STORE_SYNC_ROUTE.address(baseURL, { dataId, generation, cursor });

// Auth: append the credential to the list the route built.
new WebSocket(address.url, [...address.protocols, bearerSubprotocol(token)]);

// Server: read the offer, then echo back only the main subprotocol.
const offered = parseSubprotocols(request.headers.get("sec-websocket-protocol"));
offered.includes(MAIN_SUBPROTOCOL);
```

`isOpenWebSocketDenial` classifies a rejected upgrade so a client can tell an
auth refusal from a transport failure. The refusal carries a `SyncRefusal`
code: `'signed-out'`, `'reauth-required'`, `'auth-unavailable'`, or
`'no-credential-model'` for a client that can never open a socket. A refusal is
data, not a stop signal; the sync driver reports it and dials again.

`STORE_SYNC_ROUTE.address` is where a replica connects: the URL and the
subprotocols as one value, which auth completes with the bearer entry.

```typescript
import { bearerSubprotocol, STORE_SYNC_ROUTE } from "@epicenter/sync";

const address = STORE_SYNC_ROUTE.address(baseURL, {
  dataId,
  generation,
  cursor,
});
new WebSocket(address.url, [...address.protocols, bearerSubprotocol(token)]);
```

A `SocketTransport` (`@epicenter/sync/transport`) is the one contract for that
last step. `AuthClient` implements it, `attachStoreSync` consumes it, and no
consumer redeclares it: a transport that took a URL without its subprotocols
once shipped a replica the server refused on every upgrade.

One path (`/api/store/v1/sync`), and the addressing lives in the query: a
replica says which application `dataId` it is syncing and how far through the
log it has read. Whose data that is comes from the resolved bearer,
server-side, so there is no value a client can put in the query that reaches
another partition (ADR-0092, ADR-0225). `DATA_ID` is the data id
grammar both halves check against one definition.

## Scope

This package carries no Yjs, no document framing, and no transport. It is the
addressing and the handshake, and nothing that speaks over them: the rules about
who has been sent what live in `@epicenter/data/sync`, and the mount that
answers this route lives in `packages/server/src/store-sync/`.

## License

MIT. See [LICENSE](./LICENSE).
