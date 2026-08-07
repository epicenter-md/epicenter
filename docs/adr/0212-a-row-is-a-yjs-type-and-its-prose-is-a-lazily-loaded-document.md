# 0212. A row is a Yjs type, and its prose is a lazily loaded document

- **Status:** Proposed
- **Date:** 2026-08-07
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0214 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`). This record
  replaces an earlier 0212 that specified a hand-built cell store; that draft was
  `Proposed` and is rewritten in place, per the same-number rewrite pattern the
  corpus already uses.
- **Relates:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (the lens and the application surface),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (persistence and history).
- **Supersedes:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md)
  (`Proposed`) and, through it,
  [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md),
  [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md)
  and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
  (all `Accepted`), because retiring 0163 alone would revive them. Withdrawn from
  all four: numbered intent submission, the sealed batch and its
  `(sequence, digest)` receipt, `batch-conflict` recovery, replica-id rotation,
  settled watermarks, and the three-way bootstrap / history-gap /
  lineage-mismatch recovery taxonomy. A Yjs state vector answers all three
  recovery questions with one mechanism. The earlier 0212 draft carried these
  same supersessions for the same reason with a different replacement; the
  replacement changed, the retirement did not.
  Also [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md).
  Withdrawn: the write-once blob slot and `digest A + B -> refuse or park B`. A
  blob digest is an ordinary field a later write repoints.
- **Amends:** [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md)
  at the conflict rule and the outbox. Withdrawn: server acceptance order as the
  rule, and the durable outbox its crash-recovery paragraph depends on. What
  survives, and is restated here, is that no background conflict inbox exists and
  no losing value is shown to a person.
  Also [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
  at the unit of convergence, which becomes one Yjs attribute. Its refusal of
  distributed transactions survives and is why this record needs no cross-field
  invariant.
  Also [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md)
  at the presence law. Withdrawn: that `absent` is a terminal tombstone making an
  address single-use. An address is reusable; the content is not.
  Also [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
  at the mechanism, not the law. An unsent Yjs update *is* the obligation.
  Also [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)
  at its storage inventory: "pending intents" is withdrawn with the queue. Its
  division of labour survives.
  Also [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)
  at the publication obligation: the revision counter is replaced by the unsent
  bytes themselves. Its nullable compact projection survives.
  Also [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md)
  at the hole it named and accepted (`:262-265`). A body is a Yjs document, so it
  renders to the folder. It is still not pushable back, so the
  markdown-to-operations diff stays an unowned optimisation rather than becoming
  a prerequisite.
- **Amends:** [ADR-0135](0135-row-documents-have-application-owned-roots.md)
  (`Accepted`) at root naming only. Withdrawn: that Epicenter "does not declare,
  validate, version, reserve, enumerate, or interpret" roots. Epicenter now
  declares the root grammar `<table>/<rowId>` in the index document, reserves the
  `!` prefix, and enumerates roots to build the projection. What survives, and is
  the reason the split below matters, is that Epicenter never interprets the
  inside of a prose document: an application owns that document's shape
  completely.
- **Confirms and does not amend:**
  [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md)
  (`Accepted`, "every ordinary row inherently owns one lazy collaborative
  document"). The earlier 0212 draft proposed amending it to declare documents
  per column; that amendment is withdrawn. One lazy document per content field,
  keyed by address, is what 0130 already decides.

## Context

Epicenter holds what a person makes: their notes, tags, ratings, playlists,
saved views, recordings. Mail and tracks are mirrors that rebuild from a
provider and never merge (ADR-0192); blobs are captures written once. Only the
contributed plane needs to merge, and it is small: the real vault measures 986
notes and 2.84 MB, 3.2 frontmatter fields each, with a ~2.8 KB body.

An earlier draft of this record specified a hand-built per-field cell store with
its own version triple, digest and clock clamp: about 2,100 lines across three
records. Measured head to head against Yjs 14 on that same vault, the hand-built
store lost on every axis that matters:

| | Yjs | hand-built cell store |
| --- | --- | --- |
| stored size | **3.02 MB** | 5.11 MB |
| sync manifest | **state vector, ~0 KB** | 201 KB |
| one field changed, on the wire | **43 B** | 172 B |
| full projection rebuild | **2 ms** | 4 ms |
| a field edited 5,000 times | **2 structs, 0.1 KB** | grows linearly |

Yjs cannot do exactly one thing the hand-built store could: resolve a conflict by
recency. A concurrent write to the same field is won by the higher Yjs
`clientID`, not by whoever edited last. Verified by giving the low-`clientID`
device a 20-operation head start and making it write last; it still lost. That
loss is accepted deliberately, and it is the only thing 2,100 lines were buying.

## Decision

**A row is one Yjs type in a per-application index document. Each of its content
fields is a separate document, keyed by address and loaded on demand.**

### The index document

One `Y.Doc` per application, `gc: true`. Its roots are rows:

```txt
"notes/n1"       a row.    attrs are its scalar fields.
"notes/n2"       a row.
"!kv"            singleton values. attrs are the keys.
```

Every scalar field is one attribute, so two devices editing different fields of
one row while both offline both survive. Measured: `{"title":"Shopping",
"tags":"errands"}` from two partitioned devices. Storing the whole row in one
attribute instead loses one side, and costs a 6.5x larger delta besides.

A row carries no sequence content of its own. Rows are maps.

`!` is reserved and no lens name may begin with it, so `!kv` and `!presence`
cannot collide with a table or a field.

### Prose is a separate document

A field the lens marks as `content` is **not** stored in the row. It is its own
`Y.Doc`, keyed by the address:

```txt
"notes/n1/body"      one document, opened when the note is opened
```

The column stores nothing. The lens declaring the field is the reference, so
there is no id to store, nothing to dangle, and deleting the row implies
deleting its documents.

Measured on the real vault:

| | prose inside the row | prose as its own document |
| --- | --- | --- |
| bytes loaded at startup | 3.04 MB | **0.31 MB** |
| total stored | 3.04 MB | **2.99 MB** |
| cold open | 7.2 ms | **2.3 ms** |
| open five notes | n/a | **0.18 ms** |
| per-document overhead | n/a | **27 B** over raw text |
| ADR-0146's 1 MB bound | **3.04 MB, over** | index 0.31 MB, largest prose 30.4 KB |

The split is smaller in total, ten times smaller at startup, and it is the only
arrangement that satisfies ADR-0146's `stateBytes = 1_048_576` bound, which
ADR-0174 makes terminal. Separate documents cost 27 bytes each.

**The index syncs always; a prose document syncs when it is opened.** A closed
note's prose being minutes stale costs nothing, because nothing is reading it.
Prefetching every body is 2.7 MB and is a policy, not a mechanism.

### An application owns the inside of a prose document

Epicenter creates the document and never looks in. Plain text, a ProseMirror
tree, or anything else is the application's business, and this is the surviving
half of ADR-0135.

That containment is load-bearing rather than stylistic. `@y/prosemirror` calls
`setAttr` and `deleteAttr` on the type it binds to (`sync-utils.js:243-246`), and
`nodeToDelta` writes a node's attributes (`:435-437`), with the top-level call at
`:399` carrying the document node's own attributes. An editor bound to the row
would share an attribute namespace with the row's fields. Verified in the
separated shape: an editor writing junk attributes into its own document, then
calling `clearAttrs()`, leaves the row's fields untouched.

### Existence and deletion

`Doc.get(key)` **mints** a root: it is `map.setIfUndefined(this.share, key, ...)`
(`utils/Doc.js:197-203`). A misspelled id therefore creates a root, and roots
cannot be removed. Verified: reaching into `doc.share` and deleting corrupts the
encoder outright, so the document no longer encodes.

So one reserved attribute carries both existence and liveness:

```txt
!presence   "present" | "absent"
```

A root with no `!presence` never existed. `open(id)` checks `doc.share.has(id)`
before it ever calls `get`.

Deletion clears and marks:

```ts
for (const key of row.attrKeys()) row.deleteAttr(key)   // drop the fields
// drop each content document
row.setAttr('!presence', 'absent')
```

Clearing is what reclaims space, and it is not optional. Measured over 1,000
rows: setting a flag alone leaves the document **larger** than before
(2,908 KB against a 2,888 KB baseline), because the content is all still there.
Clearing takes it to 86 KB.

A dead row then costs a flat **21 to 23 bytes**, forever, measured from one
thousand to one hundred thousand dead rows.

### Tombstones are never collected

One hundred thousand lifetime deletions cost 2.2 MB. Collecting them instead
would require knowing every device has seen the delete, which means a device
roster, per-device positions, and a rule for when a silent device is gone. That
is a distributed-systems subsystem bought to save two megabytes.

Yjs enforces this by construction, because a root cannot be removed. The
decision is therefore a statement of what the library already does, not a policy
anything has to hold.

### Deletion is terminal; the address is not

Creating at an absent address sets `!presence` back to `"present"`. The previous
content is gone from the CRDT and comes back only from history (ADR-0214).

### Trash belongs to the application

Epicenter has one delete. An application that wants a trash uses an ordinary
nullable field and simply does not call delete yet. Retention windows, timers
and two-stage lifecycles are product decisions and do not belong in the store.

## Consequences

- **A concurrent write to the same field resolves by `clientID`, not by
  recency.** Different fields, different rows, and prose all merge correctly.
  This is the whole cost of the decision and it is not recoverable from inside
  the CRDT; ADR-0214's history is the answer when it matters.
- **Deleted:** the cell relation, the version triple, the multiset digest, the
  five-minute clock clamp, the re-stamp and its measured loss, the download
  cursor, and the authority-side merge. About 2,100 lines of record become about
  600, and the authority stops needing to understand anything but bytes.
- **A prose document is unreachable from the folder in the push direction.**
  ADR-0207's markdown body renders out and is not pushable back, unchanged.
- **`doc.share` grows monotonically.** Every row that has ever existed keeps a
  root. At the measured 21 to 23 bytes this is bounded in practice; if an
  application ever writes rows at machine rate it is not. The address should be
  able to carry a generation so a future record can replace a document wholesale,
  but no generation mechanism is built, and building one now would pay for a
  problem a decade away.
- **A prose document must never have its type replaced.** Measured: replacing the
  Yjs type behind a content field reclaims the old content correctly, but a
  handle still held by an editor keeps accepting writes that go nowhere, silently.
  The API refuses the operation rather than detecting it (ADR-0213).
- **Yjs 14 is a new API, not a new encoding.** Verified both directions: a v13
  document reads v14 bytes and a v14 document reads v13 bytes.
