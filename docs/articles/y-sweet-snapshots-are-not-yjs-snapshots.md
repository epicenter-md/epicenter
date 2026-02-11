# Y-Sweet "Snapshots" Aren't Yjs Snapshots

**TL;DR**: Y-Sweet uses the word "snapshot" in its codebase, but it's storing the full document binary, not using the Yjs `Y.Snapshot` API.

> The terminology collision is confusing. Y-Sweet's "snapshot" is a serialized dump of document state; Yjs's `Y.Snapshot` is a lightweight bookmark into operation history.

I was digging through [y-sweet](https://github.com/jamsocket/y-sweet)'s source code to understand how it persists documents. The word "snapshot" kept appearing. Was Jamsocket using the Yjs snapshot feature for versioning?

No. They're just storing the binary.

## What Y-Sweet Actually Does

From `sync_kv.rs`:

```rust
pub async fn persist(&self) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(store) = &self.store {
        let snapshot = {
            let data = self.data.lock().unwrap();
            bincode::serialize(&*data)?  // Full KV store state
        };
        store.set(&self.key, snapshot).await?;
    }
    Ok(())
}
```

That `snapshot` variable is a `BTreeMap<Vec<u8>, Vec<u8>>` serialized with bincode. It contains the complete document state: content, state vector, any pending updates, metadata. Everything needed to restore the document without replaying history.

On load:

```rust
if let Some(snapshot) = store.get(&key).await? {
    tracing::info!(size=?snapshot.len(), "Loaded snapshot");
    bincode::deserialize(&snapshot)?  // Back to BTreeMap
}
```

No `Y.snapshot()`, no delete sets, no requirement to disable garbage collection.

## The Terminology Collision

| Term               | What it is                | Size                | Requires                      |
| ------------------ | ------------------------- | ------------------- | ----------------------------- |
| `Y.Snapshot`       | State vector + delete set | ~100 bytes          | Original doc with `gc: false` |
| y-sweet "snapshot" | Full serialized document  | Varies with content | Nothing; self-contained       |

Yjs snapshots are bookmarks. They point into the document's operation history and let you reconstruct past states. But they only work if that history exists, which means disabling garbage collection forever.

Y-Sweet's "snapshots" are complete state dumps. Load one into a fresh context and you have the full document. No history needed.

## How Y-Sweet's Persistence Works

Y-Sweet uses `yrs-kvstore`, a Rust library that implements `DocOps` for Yjs persistence:

```
Client update
    │
    ▼
push_update()     Store incremental update
    │
    ▼
flush_doc()       Merge updates into document state
    │
    ▼
persist()         Serialize full state to storage
    │
    ▼
S3 / Filesystem   "{doc_id}/data.ysweet"
```

From `doc_sync.rs`, y-sweet flushes on every update:

```rust
doc.observe_update_v1(move |_, event| {
    sync_kv.push_update(DOC_NAME, &event.update).unwrap();
    sync_kv.flush_doc_with(DOC_NAME, Default::default()).unwrap();
})
```

Each document ends up as a single binary blob. When the server restarts, it loads the blob and has the complete document ready to serve.

## Why This Matters

If you're evaluating y-sweet or building your own Yjs persistence, understand what you're getting:

- Y-Sweet gives you disaster recovery and document persistence
- Y-Sweet does not give you version history or point-in-time restore
- The `Y.Snapshot` API exists for those features, but y-sweet doesn't use it

This isn't a limitation; it's a deliberate choice. Most applications don't need version history. Storing the full binary is simpler, works with garbage collection enabled, and doesn't require documents to grow forever.

If you do need version history, you'll need to build it yourself or use a different approach. See [You Probably Don't Need Yjs Snapshots](./yjs-snapshots-vs-binary-saves.md) for the tradeoffs.

## Related

- [You Probably Don't Need Yjs Snapshots](./yjs-snapshots-vs-binary-saves.md): The conceptual distinction between snapshots and binary saves
- [Y-Sweet source code](https://github.com/jamsocket/y-sweet): The full Rust implementation
- [yrs-kvstore docs](https://docs.rs/yrs-kvstore): The persistence layer y-sweet uses
- [Learn Yjs](https://learn.yjs.dev/): Interactive tutorials from Jamsocket
