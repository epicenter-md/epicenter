# The Yjs Demos Website Is an Underrated Learning Resource

**The Yjs demos site is a fantastic resource that shows you how to build collaborative apps with live editing, WebSocket sync, BroadcastChannel awareness, and production patterns like snapshots.**

> It's an underrated canonical source for understanding how real-time collaboration actually works.

Go to [demos.yjs.dev](https://demos.yjs.dev). You're looking at 8 live, production-quality reference implementations: Quill, Prosemirror, Monaco, CodeMirror 5, CodeMirror 6, and React variants. Every one of them is actively syncing right now with other people's browsers.

These aren't toy examples. They're the actual reference implementations from the Yjs maintainers. They show you exactly how to build collaborative apps, including patterns that don't get nearly enough attention in most documentation.

## What You Learn From the Demos

Open two tabs of any demo. Type in one. It appears in the other instantly. That's the dual-channel sync: WebSocket for cross-device, BroadcastChannel for same-device. Most documentation glosses over this. The demos show you it working. You see the speed. You understand why it matters.

Click the "Disconnect" button. Keep typing. Reconnect. Everything syncs. You just learned offline-first collaboration without reading a paper or thinking about state vectors.

Open [demos.yjs.dev/prosemirror-versions](https://demos.yjs.dev/prosemirror-versions). Click "Add Version" a few times while editing the document. Now click through the versions. You're looking at a fully working version control system that required zero database logic. No revision tables. No central log. Just `Y.snapshot()`, `Y.encodeSnapshot()`, and snapshots stored in a Y.Array.

This pattern doesn't get much coverage in most Yjs guides. Having a canonical implementation you can read and understand is invaluable.

Look at the Quill demo. Look at the Monaco demo. Look at CodeMirror 6. They all use the exact same sync infrastructure. Same WebSocket server. Same awareness protocol. Same CRDT logic. But the editor code is completely different. That's when you realize: the sync layer doesn't care what editor you're using. It's just bytes.

## Why This Matters

When you're building a collaborative app, you need to answer questions like:

- How do I sync across multiple devices without a massive server?
- How do I sync within the same browser across tabs?
- How do I implement version history without a database?
- How do I handle awareness (cursors, presence)?
- What happens when the connection drops?

Documentation answers these in the abstract. The demos answer them with working code. You can read the source, understand the pattern, copy it to your project, and ship.

The snapshots example is especially valuable. The prosemirror-versions demo shows you exactly how: store encoded snapshots in a Y.Array, render by passing the snapshot to the binding's sync plugin. That's a pattern you can generalize to any app.

## Deep Patterns You'll Find

Open the yjs-demos repository. Read the source code. You'll understand:

- How WebSocket providers handle dual-channel sync (WebSocket + BroadcastChannel)
- How the server works (it's shockingly simple. Just a thin relay)
- How awareness sync works separately from document sync
- How editor bindings translate between editor deltas and CRDT mutations
- How to implement version control with snapshots
- How to set up collaborative editing with any text editor

[The technical deep dive has all the details](./yjs-demos-production-patterns.md). But reading the source first makes it actually land.

## Where to Go Next

After exploring the demos:

[The Production Patterns Hiding in Yjs Demos](./yjs-demos-production-patterns.md) explains what you're seeing. Dual-channel sync, thin relay servers, snapshotting, all the architectural decisions underneath the code.

[Yjs Has Free WebSocket Infrastructure (Just for Demos)](./yjs-demos-free-websocket-infrastructure.md) shows you how to use the public server for your own prototypes.

Then dive into the full documentation and advanced patterns:

- [learn.yjs.dev](https://learn.yjs.dev): Interactive tutorials
- [Yjs documentation](https://docs.yjs.dev): Complete API reference
- [Fractional Ordering: User-Controlled Item Order in Yjs](./fractional-ordering-meta-data-structure.md): Implementing reordering
- [Yjs CRDT Patterns and Meta Data Structures](./yjs-document-structure-design.md): Schema design for CRDTs

But start with the demos. Everything else makes sense faster when you've seen it working.

---

## References

- [demos.yjs.dev](https://demos.yjs.dev)
- [yjs-demos repository](https://github.com/yjs/yjs-demos)
- [learn.yjs.dev](https://learn.yjs.dev)
- [Yjs documentation](https://docs.yjs.dev)
