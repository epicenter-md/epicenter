# @epicenter/sync

`@epicenter/sync` is the wire-format package for Epicenter sync. It owns the binary framing for Yjs sync, awareness, sync-status, and peer-to-peer RPC messages so the transport layer can stay dumb. `@epicenter/workspace` and `apps/api` use it when they need to turn a `Y.Doc` change into bytes. Or turn bytes back into something the app can reason about.

## Installation

Inside this monorepo:

```json
{
	"dependencies": {
		"@epicenter/sync": "workspace:*"
	}
}
```

This package has a peer dependency on `yjs`.

## Quick usage

The core flow is small on purpose: encode a sync message, send it over whatever transport you want, then decode or handle it on the other side.

```typescript
import * as Y from 'yjs';
import {
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
	decodeMessageType,
	decodeSyncMessage,
	encodeSyncStep1,
	handleSyncPayload,
} from '@epicenter/sync';

const doc = new Y.Doc();
doc.getMap('users').set('alice', { name: 'Alice', age: 30 });

const step1 = encodeSyncStep1({ doc });
const messageType = decodeMessageType(step1);

if (messageType === MESSAGE_TYPE.SYNC) {
	const decoded = decodeSyncMessage(step1);

	if (decoded.type === 'step1') {
		const response = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP1,
			payload: decoded.stateVector,
			doc,
			origin: null,
		});

		// send response over WebSocket, HTTP, BroadcastChannel, or anything else
	}
}
```

That example is the same shape used in the package tests and in the API room bootstrap, where the server starts a connection with `encodeSyncStep1({ doc })`.

## Dumb server, separate transport

This package is strict about one boundary: it handles protocol framing, not connection management. That split is why the same message helpers work over WebSockets, one-shot HTTP sync, or any custom relay you want to write.

The design shows up in a few places:

- `encodeSyncStep1`, `encodeSyncStep2`, and `encodeSyncUpdate` only deal with Yjs payloads.
- `encodeSyncRequest` and `decodeSyncRequest` collapse the WebSocket handshake into a binary HTTP request/response format.
- RPC framing is separate from RPC behavior. The package defines request/response bytes and shared error variants, not the transport policy around retries or timeouts.

If you want lifecycle helpers for a WebSocket server, this package is the protocol layer under them. Not the server itself.

## API overview

Main exports from `src/index.ts`:

- Message constants: `MESSAGE_TYPE`, `SYNC_MESSAGE_TYPE`, `RPC_TYPE`
- Sync encode/decode: `encodeSyncStep1`, `encodeSyncStep2`, `encodeSyncUpdate`, `decodeSyncMessage`, `handleSyncPayload`
- Awareness helpers: `encodeAwareness`, `encodeAwarenessStates`, `encodeQueryAwareness`
- HTTP sync helpers: `encodeSyncRequest`, `decodeSyncRequest`
- State helpers: `stateVectorsEqual`
- RPC helpers: `encodeRpcRequest`, `encodeRpcResponse`, `decodeRpcMessage`, `decodeRpcPayload`
- RPC types and guards: `DecodedRpcMessage`, `RpcError`, `isRpcError`

The package exports pure functions. Feed them bytes and docs; they give you bytes or decoded shapes back.

## Relationship to other packages

`@epicenter/sync` sits below the rest of the sync stack.

```text
apps/api                durable-object rooms, websocket handling
        │
@epicenter/workspace    client sync extension, rpc helpers
        │
@epicenter/sync         protocol framing and shared rpc error types
        │
yjs + y-protocols       crdt state, awareness, update encoding
```

In practice:

- `apps/api` uses it to compute initial room messages and decode incoming sync traffic.
- `@epicenter/workspace` uses it in the client sync extension.
- Other packages do not need to know about the wire format unless they are implementing a transport.

## License

AGPL-3.0. That matches the package manifest and the repository's split-license model for sync infrastructure.
