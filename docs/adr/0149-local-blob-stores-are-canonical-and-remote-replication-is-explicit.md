# 0149. Local blob stores are canonical and remote replication is explicit

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

Some Epicenter applications never need remote bytes, while others want a user
or setting to make selected objects durable across devices. Treating remote
storage as automatic blob sync would require eager downloads, background
workers, retry queues, deletion tombstones, and persisted transfer states even
for applications that do not need them.

## Decision

Application operations always read and write through a local `Blobs` store. A
signed-in composition may additionally attach one `BlobReplica` that performs
explicit same-ID `upload`, `download`, and `purge` operations. Every operation
is one-shot. The blob layer does not schedule work, retry failures, download
eagerly, or persist transfer state.

Native capture may finalize directly into the same host-owned local blob
backend and return only `BlobId`. This is the sanctioned exception to routing a
write through the portable TypeScript `Blobs.put` method: it keeps complete
recording bytes and native paths out of JSON IPC while preserving one canonical
store and identity. Playback URLs are likewise shell-owned access capabilities,
not a second byte store or part of the portable `Blobs` contract.

Epicenter Desktop implements that store once in its authenticated Bun loopback
host at top-level `<appData>/blobs`, without workspace or application
namespacing. Trusted surfaces use session-protected same-origin HTTP for
streaming writes, byte-range reads, stat, and deletion. Native capture may
publish into the same filesystem layout. This refuses a custom Tauri protocol,
whole-file WebView IPC, and a second desktop storage implementation.

Replica implementations are platform-specific behind one `BlobReplica`
contract. Browser upload can use a local `Blob`; desktop replication belongs to
the Bun host so it can stream a lazy file directly to the presigned operation.
The system does not route complete desktop recordings through the WebView merely
to reuse one transport implementation.

## Consequences

Offline local work remains unconditional and applications compose remote
durability only when they need it. Whispering can persist one successful
`uploadedAt` timestamp and derive availability from that timestamp plus a local
`stat`, without inventing a blob state machine. The timestamp is historical UI
bookkeeping, never proof that the remote object still exists: removing the
local copy first repeats the idempotent upload, and a remote 404 clears a stale
marker. Remote purge requires a live replica; there is no offline
delete-everywhere promise. Automatic age-based retention is removed because it
cannot honor that rule offline without a pending-delete ledger. This decision
does not choose whether a consumer encrypts bytes before upload.

## Considered alternatives

- One hybrid store that uploads automatically: hides network policy inside a
  storage primitive and forces every caller into retry and reconciliation.
- Two unrelated local and remote IDs: requires a mapping table and makes rows
  environment-dependent.
