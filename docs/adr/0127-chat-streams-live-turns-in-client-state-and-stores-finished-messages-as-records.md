# 0127. Chat streams live turns in client state and stores finished messages as records

- **Status:** Accepted
- **Date:** 2026-07-12
- **Supersedes:** [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md) (the canonical `@epicenter/chat` ownership and synchronized transcript promise carry forward; the keyed child-document store does not)
- **Relates:** [ADR-0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md), [ADR-0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md), [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)

## Context

ADR-0055 gave every chat surface one canonical conversation table but stored
finished messages in a keyed Yjs child document. The new records authority makes
that split unnecessary. A finished message is a bounded, independently
addressed, queryable event written once by the client loop. No two replicas
collaboratively edit its characters or structural parts.

Persisting messages in Yjs therefore pays for a second table system without
using its merge semantics. Persisting the live token stream would make temporary
rendering progress durable and multiply writes without improving the finished
transcript.

## Decision

Epicenter stores durable product entities and finished events as synchronized
records, collaboratively edited bodies as row-owned lazy Yjs documents, and
transient rendering progress in runtime state.

Chat specializes that rule in one sentence: the client loop streams one live
turn into local UI state and persists each finished message as one synchronized
SQLite row.

`@epicenter/chat` owns two canonical record tables:

```ts
const conversations = defineTable({
	fields: {
		id: field.string<ConversationId>(),
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
});

const messages = defineTable({
	fields: {
		id: field.string<MessageId>(),
		conversationId: field.reference<ConversationId>('conversations'),
		turnId: field.string<TurnId>(),
		turnStartedAt: field.instant(),
		stepIndex: field.number({ minimum: 0, multipleOf: 1 }),
		role: field.select(['user', 'assistant']),
		createdAt: field.instant(),
		parts: field.json(agentMessagePartsSchema),
	},
});
```

The exact field bounds and runtime schema land with the implementation, but the
storage semantics do not vary: `parts` is one atomic completed value. Every row
in a turn carries the same `turnId` and `turnStartedAt`; `stepIndex` preserves
causal order within it. Turns order by `turnStartedAt` with `turnId` as the
stable tie-break.

SQLite persistence is asynchronous. The loop therefore uses an asynchronous
transcript port rather than the current synchronous keyed `set/entries/observe`
store. Sending awaits the durable user-message transaction before inference
starts. A clean assistant turn commits all of its completed tool and final-answer
messages in one records transaction before the UI reports completion. An
aborted or failed partial assistant turn remains local and is dropped. Retrying
starts another ephemeral turn from the durable transcript.

The inference transport may be an HTTP event stream, another async byte stream,
or a local model. It carries temporary progress and never owns conversation
storage. A second device sees synchronized finished messages, not a
cross-device mirror of every token.

A genuinely shared draft may independently earn a row-owned child document.
Finished chat history never uses `document.keyed(...)` as a generic message
table.

## Consequences

- Conversations and messages participate in records-schema identity, logical
  export, validation, search, retention, row deletion, and any administrative
  replacement of their records epoch.
- Message and turn IDs make concurrent appends independent. A product that
  needs causal branches beyond one turn and its steps must model an explicit
  parent identity rather than relying on storage insertion order.
- Message parts are atomic after completion. The loop creates each message row
  once and never patches it. A future edit or branch must define explicit app
  semantics over rows; it does not merge characters.
- `@epicenter/chat` owns conversation deletion as one records transaction: it
  deletes every message that references the conversation, then deletes the
  conversation. Reference metadata documents the relationship but does not
  imply a generic framework cascade.
- Chat no longer needs one Yjs room per conversation, a keyed message format, or
  a document runtime merely to read transcript history.
- Every replica now carries the complete bounded transcript instead of lazily
  opening one room per conversation. This deliberately buys direct query,
  search, retention, and export at the cost of eager transcript replication.
- Cross-device live token viewing is refused. This removes token-level durable
  writes, partial-message reconciliation, stale `streaming` rows, and crash
  recovery for presentation state.
- Tool output entering `parts` must satisfy a concrete cell and mutation bound.
  A larger result remains in its owning product store and the message keeps a
  bounded reference or summary. Size alone does not turn a write-once message
  into a collaborative document.
- ADR-0047's client-loop ownership and persist-only-on-finish rule remain. Its
  synchronous keyed-store port changes to asynchronous, atomic record
  persistence.
- Tool side effects and asynchronous job results remain durable in the product
  records that own them. The chat transcript is not their commit log, and retry
  does not make a side-effecting tool exactly-once; the tool still owns
  idempotency or a durable receipt.
- Moving existing chat history is an explicit app-owned cross-plane conversion,
  not `defineRecordsMigration`. The converter enumerates known conversations,
  opens each retained keyed message room, validates and bounds every finished
  message, builds the complete target rows, and transfers authority to the
  record tables only after the import succeeds. Old rooms remain retained for
  export; old binaries must fail closed after cutover rather than keep authoring
  the abandoned plane.

## Considered alternatives

- **Keep `document.keyed(agentMessageSchema)`.** Rejected: messages need
  row-level query, retention, deletion, migration, and search, while their values
  do not need collaborative merging.
- **Write every streamed token into SQLite.** Rejected: temporary progress would
  become synchronized history, causing write amplification and recovery states
  with no durable product value.
- **Give every message a `Y.Text` or XML child document.** Rejected: ordinary
  chat messages are produced by one turn and consumed as completed values.
  Character-level concurrent editing is not part of the product promise.
- **Persist a `streaming` placeholder row.** Rejected for version one: it creates
  stale pending-state recovery after crashes. The durable user message already
  makes retry reachable, and the active device owns the live indication.
- **Keep lazy transcript replication.** Rejected for version one: ordinary chat
  history is expected to fit the complete-replica contract, and direct local
  query, search, retention, and export are worth carrying it. Measured transcript
  volume that makes complete replicas untenable reopens chat storage, but does
  not automatically make Yjs the answer.
