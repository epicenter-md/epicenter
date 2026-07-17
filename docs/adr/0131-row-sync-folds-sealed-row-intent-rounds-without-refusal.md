# 0131. Row sync folds sealed RowIntent rounds without refusal

- **Status:** Accepted
- **Date:** 2026-07-16
- **Amended:** 2026-07-17: deployment capacity admission and the submission
  watermark are deleted. Every structurally valid RowIntent in a valid sealed
  round from an enrolled replica enters authority order exactly once; the
  hosted storage allowance gates capability issuance (ADR-0137), never
  synchronization. The exact-retry receipt is `acceptedRound` plus
  `requestDigest` alone.
- **Supersedes:** [ADR-0119](0119-complete-record-maps-sync-through-schema-blind-server-ordered-patches.md)
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md), [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0133](0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), [ADR-0136](0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)

## Context

ADR-0119 split scalar row changes into `createRow`, `patchRow`, and
`deleteRow`, then allowed the authority to reject a sealed batch after the
replica had already made it durable. Row-owned bodies added a fourth
`bodyAppend` command. The replica therefore needed an append-only outbox,
command ordering, quarantine, actor rotation, rebootstrap, stored batch JSON,
and recovery rules for changes that the user had already seen locally.

The product model is smaller. A user creates, updates, or deletes one row. The
row owns both its JSON fields and its collaborative document. Their fold
laws differ, but that difference belongs inside row folding rather than in a
transport command vocabulary.

## Decision

The protocol carries one canonical row mutation type:

```ts
type RowIntent =
	| {
			kind: 'create';
			table: string;
			rowId: string;
			fields: JsonObject;
			documentUpdate?: Uint8Array;
	  }
	| ({ kind: 'update'; table: string; rowId: string } &
			(
				| {
						fields: { set: JsonObject; unset: string[] };
						documentUpdate?: Uint8Array;
				  }
				| { fields?: never; documentUpdate: Uint8Array }
			))
	| {
			kind: 'delete';
			table: string;
			rowId: string;
			fields?: never;
			documentUpdate?: never;
	  };
```

The same semantic `RowIntent` accumulates locally, persists in SQLite, freezes
inside a sealed round, crosses the wire, and folds at the authority. Physical
encodings may differ: SQLite stores document bytes as a BLOB and JSON transport
base64-encodes them. No layer translates the intent into `RecordCommand`,
`createRow`, `patchRow`, `deleteRow`, or `bodyAppend` variants.

Create contains the complete initial field postimage required by the
submitting release's table lens. The schema-blind authority validates only
bounded JSON, the 24-character row-id shape, and reserved-address rules; it does
not know which application fields are required. It does not keep deleted-id
tombstones. Conforming runtimes mint row ids once and never reuse them, as
specified by ADR-0130. Update fields use disjoint absolute `set` and `unset`
operations. Omitting a field preserves it, setting `null` stores JSON null, and
unsetting removes the property. An update must contain non-empty field changes,
a document update, or both.

A `RowIntent` is one lifecycle atom, not one all-or-nothing application atom:

- `create` on an absent address creates the fields and, when present, its
  document in one authority transaction. A create whose complete document would
  exceed the canonical document maximum no-ops as a whole. `create` on a live
  address also no-ops as a whole.
- `update` on an absent address no-ops as a whole. On a live row, its field and
  document components fold independently. A field component that would exceed
  the row cap no-ops and may visibly correct at retirement. A document component
  that would make the merged canonical document exceed its bound also no-ops;
  an admissible document update still merges. Scalar and document capacity
  races cannot discard each other's component.
- `delete` removes the row fields and document state in one authority
  transaction. Delete on absence is a deterministic no-op.

Conflict semantics follow the kind of data being changed:

```txt
ordinary scalar fields
  absolute set/unset
  later authority acceptance wins

collaborative document
  Yjs CRDT merge

critical workflow
  application-specific authority operation with its own validation and transaction
```

Scalar field changes fold in authority acceptance order. Device clocks,
authorship timestamps, and offline duration do not participate in conflict
resolution. Consequently, an older offline field change may supersede a
newer-authored change when the authority accepts the offline change later.

An application must not encode a workflow as ordinary fields when silently
losing one participant's update would violate a business invariant. Inventory
reservation, balance transfer, uniqueness claims, and similar operations need
an application-specific authority operation. RowIntent does not grow compare-
and-set, clock arbitration, or a generic remote transaction language for them.

The reserved KV address accepts only field-bearing `update` intents. It folds
an absent physical payload from `{}`, materializes on first write, and rejects
`create`, `delete`, and document-bearing intents before sealing.

The replica has two private intent states. Open RowIntents are durable local
work that may still compact. A sealed round is an immutable retry image under
one round number and digest. Edits authored while a round is unresolved remain
open for a later round. Nothing compacts across that boundary.

Sealing selects a deterministic bounded subset of open RowIntents. Intents that
do not fit remain open for later rounds. A document edit first merges into the
open intent. If that pending delta approaches its ceiling, the replica hydrates
confirmed, sealed, and open state into a fresh `gc: true` Yjs document, then
stores the smaller of a delta against the confirmed-plus-sealed base and a full
state update. Sealing freezes those exact bytes.

The active protocol defines an encoded canonical document maximum and keeps it
strictly below the maximum document component in one RowIntent. That component
maximum in turn stays below the sealed-round, request, and deployment-backend
limits. The concrete byte values are selected from benchmarks before the
protocol lands, not guessed in this ADR. Local admission never commits a
RowIntent that cannot be sent. If even a compact full state exceeds the
document maximum, persistence of the edit fails and the document handle follows
ADR-0134's poison-and-reopen rule. Chunking, streaming, upload sessions, and
multiple document fragments remain refused. Yjs garbage collection removes
deleted-history overhead, not live content, so applications must keep row
documents within the interactive-content bound.

Client admission is not the authority bound. Two replicas can each produce a
valid bounded state whose merge is too large. For every document-bearing fold,
the authority's injected Yjs codec computes the merged compact state before
commit. If it exceeds the canonical document maximum, the document component
deterministically no-ops while an independently admissible field component may
still apply. This is an ordinary confirmed outcome, not a rejected sealed round
or a new recovery lifecycle.

Replica identity is explicitly enrolled by the authority before this exchange.
Ordinary `sync` never creates authority state for an unseen client-supplied id.
Enrollment mints and returns the protocol identity whose exact-retry receipt the
authority will retain; authentication separately decides whether the caller may
access the workspace.

The exchanges are:

```txt
enroll({ protocolMajor }) -> { replicaId }

sync({
  token,
  protocolMajor,
  sealedRound?: { round, requestDigest, intents[] }
})
```

Enrollment creates the receipt at accepted round zero with no request digest.
The receipt is `(replicaId, acceptedRound, requestDigest)` and nothing else:
exactly the state needed to distinguish the next round, an exact retry, and a
fork.

The authority evaluates a sealed round in this order: protocol major, replica
identity, retry-head position, and then semantic RowIntent folding. Every
structurally valid sealed round at `acceptedRound + 1` from an enrolled
replica folds; there is no deployment admission step, and quota never
participates in synchronization (ADR-0137). After a round folds, row effects,
emitted outcomes, and the retry head commit in one authority transaction. A
matching retry refolds nothing. A digest mismatch or a round other than
`acceptedRound` or `acceptedRound + 1` is a terminal replica fork that
mutates nothing. The sealed round stays durable through every response page
and retires only after the exchange reaches head.

The replica has exactly one exclusive writer process. The runtime enforces
that lease physically (the browser's OPFS synchronous access handle and
process-local file ownership elsewhere). A newly sealed round is always
`acceptedRound + 1`, and until the client receives a definitive response it
retries the byte-identical round, digest, and intents. Round numbers are
never reused with different content, so the receipt alone makes duplicates
idempotent: a delayed duplicate of the accepted round matches the digest and
refolds nothing, and a delayed duplicate of an older round answers a dead
connection with a fork response and no state change.

The accepted-round retry head is the durable core of that replica's retry
chain and is not removed by outcome-tail compaction or baseline acquisition.
It remains until workspace deletion. There is no replica-specific count, slot
allocation, generation, eviction, expiration, or unenrollment lifecycle.
Baseline acquisition keeps the same replica id, sealed round, digest, and
canonical RowIntent rows. Scratch confirmed state is disposable; authored
intent and exact-retry identity are not.

Hosted storage policy gates capability issuance, never synchronization
(ADR-0137). Enrollment is the one storage-producing capability this surface
creates; a hosted deployment may refuse to issue it (`enrollment-refused`)
when the account allowance is exhausted, and may throttle it operationally.
Once a replica is enrolled, its valid durable RowIntents always synchronize;
an over-allowance account may at most receive an informational warning, never
a mutation gate. Honest offline backlog may exceed the allowance without a
fixed local ceiling. Self-hosted operators own their available storage and
compose no quota. Abuse suspension and authorization revocation remain
separate operational controls, not protocol states.

Elapsed time never changes a durable RowIntent's eligibility. After baseline
acquisition, the replica automatically retries its sealed round and seals newer
open intent through the ordinary protocol. There is no expiration threshold,
recovery copy, or stale-change review state. Ordinary RowIntent folding decides
the result, so automatic submission does not promise that an old change wins.

Confirmed outcome transport remains distinct from authorship intent. One
applied RowIntent consumes one authority sequence and emits one composite row
outcome: the complete field postimage when fields changed, the opaque document
update when the document changed, or both. Delete emits one deletion outcome.
These outcomes are never replayed as RowIntents. A deterministic no-op may consume an
authority sequence without emitting a row fact; the page checkpoint advances
across that gap.

## Consequences

- ADR-0119's durable product semantics survive: complete schema-opaque replicas,
  absolute set/unset field changes, authority order, unknown-key preservation,
  logical ownership export, no application history, and no partial replication.
- The three scalar commands and `bodyAppend` disappear from the wire. A create
  with an initial document needs no scalar-before-document ordering or parking
  rule.
- Quarantine, dependent-intent partitioning, actor rotation, forced
  rebootstrap, per-command actor sequences, stored batch JSON, and durable
  rejection history disappear.
- A fold may partially apply the components of a live-row update. That is
  deliberate: lifecycle validity is shared, while scalar capacity, document
  capacity, and CRDT merge are independent laws.
- Concurrent bounded documents may merge above the canonical maximum. The later
  accepted document component no-ops rather than making confirmed state
  unsendable or creating a chunking protocol.
- Exact lost-response retry remains mandatory. Open and sealed are lifecycle
  states around the same semantic type, not separate command formats.
- Protocol acceptance is distinct from semantic effect: ordinary deterministic
  create/update/delete no-ops remain valid outcomes of a folded round.
- Document update encoding and its bounds are one workspace protocol decision,
  not a per-table contract. A build supports exactly one active wire protocol
  major. A different major is refused before enrollment or round folding; there
  is no permanent previous-major compatibility path, negotiation registry, or
  protocol catalog.
- Exact-retry receipts consume authority storage for the workspace lifetime.
  Enrollment-time capability admission and operational throttling (ADR-0137)
  bound that cost without inventing replica-count plans or device lifecycle
  policy.

## Considered alternatives

- **Keep scalar commands plus `bodyAppend`.** Rejected because authority
  storage mechanics leak into authorship and force one row change through a
  translation and ordering ladder.
- **Make a combined update atomic across fields and document.** Rejected because
  a concurrent scalar capacity race could silently discard durable
  collaborative text.
- **Trust client-side document admission as the authority bound.** Rejected
  because two valid offline documents can merge above the maximum.
- **Let one oversized open intent remain durable until the network improves.**
  Rejected because no network condition can make a protocol-oversized intent
  sendable.
- **Cap or recycle enrolled replicas.** Rejected because correctness needs a
  durable retry receipt, not a product device limit. Aggregate authority storage
  admission bounds the resource instead.
- **Expire or unenroll inactive replicas.** Rejected because time and device
  management would create another retry-chain lifecycle. Receipts end only with
  workspace deletion.
- **Store or replay RowIntents as confirmed history.** Rejected because sync is
  not an audit product; confirmed pages carry resulting facts instead.
- **Refuse storage growth inside synchronization (delete-only admission plus a
  submission watermark).** Built, then deleted by the 2026-07-17 amendment.
  Refusing a sealed round mid-sync forced a whole recovery family: per-replica
  submission numbering, a durable watermark write on every transmission,
  refusal-authoritativeness rules, sealed-to-open reopening, delete-first
  resealing under a reused round number, and a client capacity-blocked state.
  Gating capability issuance instead (ADR-0137) deletes all of it while
  keeping the allowance enforceable, because enrollment is where new growth
  capability is created and existing replicas' durable edits must always
  drain.
