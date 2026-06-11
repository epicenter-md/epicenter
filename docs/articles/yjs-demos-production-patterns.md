# The Production Patterns Hiding in Yjs Demos

**The Yjs demos run so fast because they implement patterns most developers don't realize are being demonstrated. Dual-channel sync, thin relay servers, and version history without central logic.**

> Every Yjs demo is a working reference implementation. Not toys. Not tutorials. Production code that shows you exactly how to build collaborative apps.

If you've opened [demos.yjs.dev](https://demos.yjs.dev) and typed in a Quill editor while watching another browser tab sync in real time, you've experienced a CRDT doing what it does best. But the architecture underneath is worth understanding because it solves problems you'll face building anything collaborative.

The demos are hosted at `demos.yjs.dev/quill/quill.html`, `demos.yjs.dev/prosemirror/prosemirror.html`, and five others. The [yjs-demos repository](https://github.com/yjs/yjs-demos) contains all the source. Every single one follows the same initialization pattern:

```javascript
const ydoc = new Y.Doc()
const roomname = `quill-demo-${new Date().toLocaleDateString('en-CA')}`
const provider = new WebsocketProvider('wss://demos.yjs.dev/ws', roomname, ydoc)
const ytext = ydoc.getText('quill')
const binding = new QuillBinding(ytext, editor, provider.awareness)
```

That's it. A document, a room name, a WebSocket provider, a shared type, and a binding. Simple enough. But here's what's actually happening underneath: two separate sync channels, a server that's almost a pass-through, and persistence without any database logic. These patterns scale and solve real production problems.

## The Invisible Dual-Channel Architecture

When you open the demo in two browser tabs, they sync instantly. Sub-millisecond. Type in tab A, tab B updates before you can blink. Then click the "Disconnect" button, type more in tab A, reconnect, and everything syncs perfectly.

The speed is because of a pattern hidden inside `y-websocket` provider that developers rarely talk about: the same code handles WebSocket communication _and_ cross-tab sync via BroadcastChannel. These run in parallel:

```
┌──────────────────────────────────────────────────────────────┐
│ Browser Process (same origin)                                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────┐         ┌──────────────────────┐  │
│  │  Tab 1 (Quill)      │         │  Tab 2 (Quill)       │  │
│  │  Y.Doc instance     │         │  Y.Doc instance      │  │
│  └──────────┬──────────┘         └──────────┬───────────┘  │
│             │                               │               │
│             │ updates sync via              │ updates sync  │
│             │ BroadcastChannel              │ via same      │
│             │ (<1ms, local)                 │ channel       │
│             └───────────────┬───────────────┘               │
│                             │                               │
│                    ┌────────▼────────┐                      │
│                    │ BroadcastChannel│                      │
│                    │ (cross-tab sync)│                      │
│                    └──────────────────┘                      │
│                                                              │
│  Also (both tabs):                                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ WebSocket to wss://demos.yjs.dev/ws                 │  │
│  │ (<100ms roundtrip, persistence + other tabs)        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The BroadcastChannel lets same-origin tabs synchronize with zero network latency. The WebSocket lets any device in the world join the same session and persists state on the server. Both channels operate independently. If the WebSocket is down, tabs still sync. If you disconnect from the network, local tabs keep working.

This is handled automatically inside the `y-websocket` provider. There's no config. No opt-in. It just works. But most developers don't realize it exists because you never have to think about it.

## Connect/Disconnect: What Actually Happens

Every demo has a button that toggles the connection. Click it and the button text changes from "Disconnect" to "Connect". Conceptually simple. Implementation-wise, it reveals the dual-channel design.

Disconnecting calls `provider.disconnect()`, which does three things:

1. Sets `provider.shouldConnect = false` so auto-reconnect doesn't kick in
2. Calls `disconnectBc()` to unsubscribe from BroadcastChannel and broadcast an awareness removal message (tells other tabs "I'm offline, clear my cursor")
3. Calls `closeWebsocketConnection()` to close the actual TCP connection

Here's what matters: your local `Y.Doc` is completely intact. You can keep typing. Edits accumulate locally. When you reconnect, the provider's `connect()` method opens a new WebSocket and immediately sends Sync Step 1. A compact encoding of "here's what I already have."

The server receives that state vector, compares it against its document state, and responds with Sync Step 2: only the missing updates. Your local doc merges those updates. All your buffered edits are sent to the server. Other clients receive them. Everyone converges to the same state.

This happens in the `setupWS()` function inside y-websocket. When the connection opens:

```javascript
websocket.onopen = () => {
  // Send sync step 1: compact state vector
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, provider.doc)
  websocket.send(encoding.toUint8Array(encoder))

  // Broadcast your user state (presence)
  if (provider.awareness.getLocalState() !== null) {
    const encoderAwarenessState = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessState, messageAwareness)
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [provider.doc.clientID])
    )
    websocket.send(encoding.toUint8Array(encoderAwarenessState))
  }
}
```

Two messages fire: sync protocol and awareness. That's the entire reconnect ceremony. No auth, no "apply pending changes," no conflict resolution logic. The CRDT handles it.

## The Thin Relay Server Pattern

The demo server at `wss://demos.yjs.dev/ws` is intentionally simple. It's roughly 50 lines of code. Here's the core pattern:

```javascript
const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (conn, req) => {
  // Get room from URL
  const room = req.url.slice(1)

  // Get or create the document for this room
  let ydoc = rooms.get(room)
  if (!ydoc) {
    ydoc = new Y.Doc()
    rooms.set(room, ydoc)
  }

  // Send the client the current state
  const state = Y.encodeStateAsUpdate(ydoc)
  conn.send(Buffer.from(state))

  // Listen for updates from this client
  conn.on('message', (message) => {
    const update = new Uint8Array(message)
    Y.applyUpdate(ydoc, update)

    // Broadcast to all other clients in this room
    for (const peer of peers) {
      if (peer !== conn && peer.room === room) {
        peer.send(Buffer.from(update))
      }
    }
  })
})
```

No CRDT logic on the server. No conflict resolution. No operational transforms. The server doesn't even know it's handling a CRDT. It just receives bytes, applies them to a Y.Doc, and broadcasts those same bytes to other clients. The intelligence is entirely on the client side.

This is the opposite of traditional collaborative editing servers, which have to merge operations, resolve conflicts, and maintain canonical state. The Yjs pattern inverts this: clients sync peer-to-peer via CRDTs, the server is just a relay and durability layer.

Compare two approaches:

| Traditional Server                     | Thin Relay (Yjs Pattern)     |
| -------------------------------------- | ---------------------------- |
| Server resolves conflicts              | Clients resolve via CRDT     |
| Server maintains canonical state       | Server just stores bytes     |
| Complex business logic                 | ~50 lines of code            |
| Scales vertically (bigger server)      | Scales horizontally (more servers) |
| Hard to test (state reconciliation)    | Easy to test (deterministic) |

The demos use this pattern across all 8 editors. Quill, ProseMirror, Monaco, CodeMirror 5 & 6, and the React variants. Same server architecture works for all of them because the server never cares about editor-specific logic.

## Awareness and Ephemeral State

Every demo shows remote cursors. When you type in one tab and watch another tab show a cursor blinking nearby, that's the awareness protocol. It's separate from the document sync.

Demos set up awareness with random user colors:

```javascript
const usercolors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' }
]
const userColor = usercolors[Math.floor(Math.random() * usercolors.length)]

provider.awareness.setLocalStateField('user', {
  name: 'Anonymous ' + Math.floor(Math.random() * 100),
  color: userColor.color,
  colorLight: userColor.light
})
```

This metadata is broadcast via awareness, not stored in the CRDT. It's ephemeral. If you disconnect, your awareness state vanishes. It doesn't persist. Other clients automatically clean up your cursor, your name badge, everything.

The awareness protocol is built into `y-websocket` the same way BroadcastChannel is: automatic, no config. It piggybacks on the same WebSocket connection but uses a different message type (messageAwareness instead of messageSync). Clients broadcast awareness updates whenever their local state changes, and the server repeats them to all other peers.

## Snapshotting: Version History Without Central Logic

The `prosemirror-versions` demo does something special that most developers don't realize is being demonstrated: it implements version history using Yjs snapshots. No database. No revision tables. No server-side diff storage.

A snapshot captures the document state at a moment in time:

```javascript
const addVersion = () => {
  const versions = ydoc.getArray('versions')
  const snapshot = Y.snapshot(ydoc)

  versions.push([{
    date: new Date().getTime(),
    snapshot: Y.encodeSnapshot(snapshot),
    clientID: ydoc.clientID
  }])
}
```

The snapshot is encoded as a Uint8Array and stored in a Y.Array. To render a specific version, you pass the snapshot to the editor's sync plugin:

```javascript
const renderVersion = (snapshot) => {
  const prevSnapshot = currentSnapshot
  editorView.dispatch(editorView.state.tr.setMeta(
    ySyncPluginKey,
    { snapshot, prevSnapshot }
  ))
}
```

The editor diff-renders from the previous snapshot to the new snapshot. It's a fully working version control system in a few lines.

One detail: the demo server disables garbage collection for the prosemirror-versions room specifically. That's because Yjs normally cleans up deleted content to save memory (via `ydoc.gc = true`). For version history, you want to preserve all edits so you can replay any snapshot. So the room name check in the server:

```javascript
wss.on('connection', (conn, req) => {
  const disableGC = req.url.slice(1) === 'ws/prosemirror-versions'
  setupWSConnection(conn, req, { gc: !disableGC })
})
```

This pattern is generalizable. You can implement snapshots and version history in any Yjs app with the same approach: store encoded snapshots in a Y.Array, render them by passing to the binding, manage GC based on your retention policy.

## The Common Architecture Across All Demos

All 8 demos (Quill, Prosemirror, Prosemirror Versions, Monaco, Monaco React, CodeMirror 5, CodeMirror 6, React-Prosemirror) use the same structure:

```javascript
// 1. Create a document
const ydoc = new Y.Doc()

// 2. Date-based room (everyone on same day collaborates)
const roomname = `${editor}-demo-${new Date().toLocaleDateString('en-CA')}`

// 3. Connect to public server
const provider = new WebsocketProvider(
  'wss://demos.yjs.dev/ws',
  roomname,
  ydoc
)

// 4. Get shared type (Y.Text for plain text, Y.XmlFragment for rich text)
const ytext = ydoc.getText('content')

// 5. Bind to editor
const binding = new {Editor}Binding(ytext, editor, provider.awareness)

// 6. Optional: setup UI for presence
provider.awareness.setLocalStateField('user', { name, color })

// 7. Optional: add connect/disconnect button
connectBtn.addEventListener('click', () => {
  if (provider.shouldConnect) {
    provider.disconnect()
  } else {
    provider.connect()
  }
})
```

This pattern works because the binding handles the translation between editor deltas and CRDT operations. Quill's `QuillBinding` converts Quill Delta operations to Y.Text mutations. Monaco's `MonacoBinding` does the same for Monaco's edit operations. The server doesn't know the difference. The provider doesn't know the difference. They just sync bytes.

## What Makes These Patterns Production-Ready

The demos reveal patterns that scale to production because they're already solving real problems:

1. **Dual-channel sync** reduces server load. Tab-to-tab updates don't hit the network. The server only handles cross-device traffic. This means the thin relay can handle thousands of concurrent clients per room without breaking a sweat.

2. **The thin relay pattern** means you can run the same server logic with different databases, add custom business logic at the edges, or deploy to edge networks. The server is a pass-through, so it becomes an implementation detail.

3. **Offline-first by default**. Clients buffer edits locally. When they reconnect, sync happens deterministically. No "sync conflict" errors. No "which version is authoritative?" questions. The CRDT answers that.

4. **Version history without central logic**. Snapshots are calculated locally. Stored in the CRDT. No need for a separate versioning system or database.

5. **Awareness is ephemeral**. Cursors disappear when clients disconnect. No stale presence state. No cleanup logic needed.

These patterns solve problems that traditional architecture requires complexity to handle. That's why the demos feel so snappy and run on such simple infrastructure.

---

For more on these patterns:

- [Yjs CRDT patterns and meta data structures](./yjs-document-structure-design.md)
- [Fractional Ordering: User-Controlled Item Order in Yjs](./fractional-ordering-meta-data-structure.md)
- [Why Yjs Is Surprisingly Fast](./why-yjs-is-surprisingly-fast.md)

And see the companion articles:

- [Yjs Has Free WebSocket Infrastructure (Just for Demos)](./yjs-demos-free-websocket-infrastructure.md): how to use the public server for your own prototypes
- [Why the Yjs Demos Website Is Your Best Learning Resource](./yjs-demos-best-learning-resource.md): meta-level guide to learning from demos.yjs.dev

---

## References

- [yjs-demos repository](https://github.com/yjs/yjs-demos)
- [demos.yjs.dev](https://demos.yjs.dev)
- [y-websocket provider source](https://github.com/yjs/y-websocket/blob/master/src/y-websocket.js)
- [Yjs snapshots documentation](https://docs.yjs.dev/api/document-apis#snapshot)
- [Y.Text API](https://docs.yjs.dev/api/shared-types/y.text)
