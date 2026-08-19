# 0036. An answer body is a native parts array; its text streams into Y.Text

- **Status:** Superseded
- **Superseded by:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (the live turn streams in client state and finished messages persist as records; no answer body streams into Y.Text). The parts-array body shape carries forward as the persisted-record shape.
- **Date:** 2026-06-18
- **Resolves:** [ADR-0031](0031-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md)'s open decision on how a streaming answer body is stored
- **Relates:** [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (actions are the tools), [ADR-0030](0030-agents-are-immutable-capability-bundles.md) (agents)

> **Vocabulary:** an **answer body** is the `body` of an addressed reply region
> (ADR-0031). A **part** is one element of a TanStack AI `MessagePart[]`: a `text`,
> `tool-call`, `tool-result`, or `thinking` segment. A **recipe** is the durable
> input a tool-call carries (for Local Books, the SQL string); a **result** is the
> output that input produces. A **capped result** is a result stored truncated to a
> fixed character budget with a `[truncated: N of M]` marker.

## Context

ADR-0031 left open how a streaming answer body is stored and framed it as a choice
over streamed text: into a durable `Y.Text` (a device can refresh mid-stream and
still see the partial, but it feared a per-token insert floor) or over awareness
(no floor, no durable partial). Two facts sharpen the answer. The request/response
engine has a second consumer beyond chat: Local Books answers by running SQL, so
its body is tool-calls interleaved with prose, not a single text run. And the chat
stack speaks TanStack AI, whose assistant message is a `MessagePart[]`
(`text | tool-call | tool-result | thinking | ...`) that the stream processor
mutates in place per chunk, growing `TextPart.content` and `ToolCallPart.arguments`
and transitioning `state`.

The floor fear was the deciding force, so it had to be checked against Yjs rather
than assumed. With gc enabled, Yjs merges contiguous same-client items (`mergeWith`)
both while live and, as `GC` structs, after deletion. A single writer streaming N
tokens into a `Y.Text` therefore compacts to roughly the content size, live or
deleted; the unbounded fragmentation ADR-0031 worried about comes from interleaved
multi-client history, not from one agent streaming one answer. The floor is a
multi-writer phenomenon, and a reply region is single-writer by ADR-0031's own
decision.

## Decision

An answer body is an ordered, append-only `Y.Array` of typed parts (the TanStack
AI `MessagePart` shapes). Each part is a `Y.Map` keyed by `type`. A part's streamed
text (`TextPart.content`, `ToolCallPart.arguments`) is a `Y.Text` that tokens
append into; scalar fields (`state`, `name`, the parsed `input`) are `Y.Map` keys.
This generalizes the current `chat-doc.ts` schema (one message-map with a single
`content` `Y.Text`) into many typed part-maps per answer, and keeps the streaming
mechanism that already works.

- **Streaming is suffix-append into `Y.Text`, batched per tick, not a blob
  overwrite.** Each debounce tick (~150ms), one transaction appends any new parts
  and inserts each text or args part's new tail
  (`ytext.insert(ytext.length, snapshot.slice(ytext.length))`). One token becomes
  one merged insert; a late observer syncs the delta, not a resend.
- **The reconciler is safe because TanStack parts grow append-only.** Text grows in
  place or a new text part is appended after a tool-call; args accumulate; scalars
  are set. There is no middle-insert and no reorder, so suffix-append plus field-set
  covers every transition. A full re-serialize of one part is the fallback if a
  snapshot ever violates monotonic growth.
- **Store the recipe and a capped result; prune old results from the prompt.**
  Persist `text` parts, `tool-call` parts (`{ name, input, state }`, the recipe), and
  `tool-result` parts whose `content` is truncated to a fixed character cap with a
  `[truncated: N of M]` marker. Drop only `thinking`. The durable transcript is then
  self-contained and renders identically on every device, with or without the local
  data the tool reads. Token cost is a separate concern, managed by pruning old
  `tool-result` content when building the model prompt (the AI SDK `before-last-N`
  pattern), never by omitting results from storage. The stored result is a faithful
  point-in-time snapshot; the recipe powers an optional refresh that re-runs against
  the current data. A capped result is lossy for the model too, but recoverable: if a
  later turn needs detail the cap dropped, the model re-calls the tool. Freeze a
  recipe only at `input-complete`, never from half-streamed `arguments`.
- **Tool execution is local; inference may be cloud-metered.** A tool runs where its
  data lives. Local Books' SQL cache is local and never stored in the cloud, so the
  SQL tool is a client tool (`tool-bridge.ts` `.tools`, run in the browser or a
  local daemon). The LLM never touches the cache, so inference can ride the metered
  cloud route (`.definitions` on the wire). The only excluded runtime is
  cloud-executes-the-tool.
- **Chat is the empty-toolset case.** zhongwen's reply is a parts array that only
  ever holds `text` parts, which is today's single-content message generalized; its
  responder is the same tool loop with `tools: []`; its persistence projection drops
  nothing. zhongwen is Local Books without tools, at the body, responder, and
  persistence layers.

## Consequences

- **Resolves ADR-0031's open decision toward its own option A: stream into the
  durable `Y.Text`.** The partial survives a mid-stream refresh, and the floor cost
  it feared is negligible for a single-writer region because Yjs merges the
  contiguous same-client inserts. Awareness streaming is unnecessary.
- **Correction of an earlier draft of this ADR.** A first pass proposed storing the
  body as an overwrite blob (`y-keyvalue-lww`) for a storage-floor benefit that does
  not exist. Grounding against `yjs/yjs` confirms overwrite and native end at
  comparable at-rest size after GC, but overwrite produces more update-log traffic
  because it resends the growing value each flush, where native sends each token
  once. In a local-first synced app, update traffic is sync bandwidth, so native
  wins. Overwrite's only edge was implementation simplicity, and native is a
  generalization of code that already streams this way.
- **The migration generalizes a schema rather than replacing the whole model.** The
  `chat-doc.ts` rewrite turns one content `Y.Text` per message into a parts array
  whose text parts are `Y.Text`. zhongwen is the tracer and must stream and reload
  byte-identical through the generalized path before any tool-using consumer arrives.
- **Storing a capped result is the right trade; re-deriving on read was not.** The
  field default is to persist tool results (the AI SDK treats the `UIMessage`, results
  included, as the source of truth for restoring a chat) and to manage tokens by
  pruning old results from the *prompt*, not by dropping them from *storage*. An
  earlier draft of this ADR re-derived results on read to save storage; that breaks
  the local-first premise. Local Books' data cache is local and unsynced, so
  re-running a past query on a device without the cache renders nothing, and two
  devices that both have caches render different rows (they pulled at different
  times). Storing the result makes the transcript a real synced artifact: rendering
  needs no cache, only generation does (inherent: the agent must run the query to
  answer). The cap bounds the cost to ~O(cap x turns), one single-writer write per
  result, which compacts.
- **One boundary seam.** opensidian's `ui-message.ts` already converts persisted
  parts to `MessagePart[]`. The only write-time projection is truncating a large
  `tool-result` to the cap and dropping `thinking`; zhongwen's projection is identity
  (text-only). Drift in the part union fails at that one file. opensidian's own
  JSON-blob persistence is fine for its in-component chat model and is not the
  precedent here, where the agent streams into the synced doc and observers render
  from sync.

## Considered alternatives

- **Overwrite a serialized parts blob (`y-keyvalue-lww`).** Rejected on grounding:
  comparable at-rest size, more update-log traffic, no floor advantage for a
  single-writer region. Simpler to write, not worth the bandwidth.
- **One `Y.Text` for the whole answer.** Rejected: it cannot hold a tool-call part,
  its state machine, or its recipe.
- **Store full, uncapped tool results.** Rejected: a year of transactions is ~400KB
  per result, compounding per turn. The cap keeps the self-contained benefit without
  the unbounded cost; the model recovers dropped detail by re-calling the tool.
- **Re-derive results on read, store no result (an earlier draft).** Rejected: breaks
  cross-device rendering for an unsynced local cache, and forces every rendering
  device to hold the cache. Token savings come from prompt-pruning instead, which is
  orthogonal to storage.
- **Stream over awareness and commit once (ADR-0031's option B).** Rejected: drops
  the durable mid-stream partial, which native streaming keeps at negligible floor
  cost.

## Open input (not an engine decision)

How the local SQLite cache is populated and refreshed (client-side QuickBooks OAuth
pull, or a relay that pulls and the client mirrors) is a Local Books product
question the QuickBooks read spike answers. It changes where the SQL tool runs in
practice but not this body shape.
