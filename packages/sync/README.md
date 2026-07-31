# @epicenter/sync

WebSocket subprotocol auth: the one vocabulary the client and server halves of
an Epicenter WebSocket handshake must agree on.

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

## Scope

This package carries no Yjs, no document framing, and no transport.

The Yjs sync wire protocol it was named for is gone. ADR-0166 replaced the
room plane with the Epicenter authority, and document synchronization now runs
over HTTP with no WebSocket at all (ADR-0174). The attach relay (ADR-0115) is
the only remaining WebSocket surface, and it forwards opaque bytes rather than
framing document updates.

The name therefore no longer describes the contents. Renaming or folding this
into `@epicenter/auth` is deferred rather than done quietly, because the
package is published and the move would cross the MIT/AGPL boundary.

## License

MIT. See [LICENSE](./LICENSE).
