# 0295. A database is one Yjs document and a row holds its rich content

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes:** [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) entirely, [ADR-0278](0278-a-replica-syncs-the-application-document-and-fetches-row-documents-on-demand.md) entirely, [ADR-0284](0284-the-application-document-is-an-index-and-a-rows-remaining-fields-live-in-its-own-document.md) entirely.
- **Amends:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) at the object granularity and the per-row HTTP surface; [ADR-0282](0282-the-authority-hydrates-the-document-and-one-object-per-document-bounds-the-blast-radius.md) at one-object-per-document; [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) at the per-document routes and the address register; [ADR-0280](0280-a-browser-stores-durable-record-is-a-chain-of-updates-in-indexeddb-folded-on-idle.md) at the document dimension of the record key; [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) and [ADR-0290](0290-a-mint-is-a-foreground-job-the-client-owns-and-it-cannot-outlive-a-page.md) at their per-document upload invariants.
- **Relates:** [ADR-0294](0294-a-database-is-sized-against-a-measured-device-budget-not-an-assumed-ceiling.md), which withdrew the memory justification for the split this record retires; [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md), whose shape this restores; [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md), which this makes literally true.
- **Unbuilt:** the client and the authority are both built. A database is one
  `Y.Doc`, a rich field is a nested type on the row, and `store/envelope.ts`,
  `store/documents.ts`, the derived row addresses and the tombstone protocol are
  deleted. The authority is `sync/authority.ts`, byte-blind and positional
  (ADR-0298), and the document-aware twin this record's `Amends` on ADR-0277
  pointed at is deleted rather than kept. What remains unbuilt is the generation
  layer: ADR-0292's exact-generation cache, ADR-0293's import-creates-a-
  generation path, and the ledger row.

## Context

A database was N Yjs documents: one application document holding every row's
scalar fields, and one document per row holding its rich content. That split
exists for one reason, and the reason is an engine property rather than a
product need: Yjs cannot partially hydrate a document, so the document boundary
is the residency boundary. Splitting rows out of the index was the only way to
keep prose off every device's boot path.

In Yjs the document is also the sync stream, the storage object, the server
addressing unit, and the identity. They cannot be separated. So a split made for
residency bought an envelope to re-multiplex what it had split, one Durable
Object per row document, derived row addresses, a document identity stamp, a
tombstone protocol to delete across two documents, and a declared index/record
field split every application author had to learn.

Measured, the split buys about two times on the client. The index alone at
25,000 rows is 133 MB (notes) to 254 MB (recordings), so the row ceiling is set
by the index either way; what the split defers is bodies, not rows. On the
authority it costs 30,001 objects per generation at the stated ceiling, whose
per-object overhead prices at 8.2 times the content it carries (ADR-0287).

## Decision

**A database is one Yjs document.** It has one identity, one socket, one
authority object, one stored blob, one address.

Its layout, which is ADR-0215's restored and is already what `store/document.ts`
builds for the application document:

```txt
Y.Doc
├── "kv"                    Y.Type   root
│     └── theme, sidebarWidth, …
└── "tables:notes"          Y.Type   root
      └── note-abc123       Y.Type   the row
            ├── title      = "Q3 planning"     scalar: a plain value
            ├── pinned     = true              scalar
            └── body     → Y.Type              rich: a nested type
```

A row is a nested `Y.Type` under its table root. Its attributes are the declared
fields. A scalar field holds a plain value; a rich field holds a nested
`Y.Type`. Row existence is the presence of the nested type, and there is no
second fact to consult.

**A rich field is never a top-level root.** `Item.write` resolves a root-parented
item through `findRootTypeKey`, a linear scan of `doc.share`: one root per row
costs 23 ms at 1,000 rows, 364 ms at 5,000, and 5,417 ms at 20,000, against
1.8 / 3.0 / 13.1 ms nested (`evidence/bench/row-model.ts`, ADR-0212).

**A rich field is minted exactly once, in the transaction that mints its row.**
Root types converge by name; nested types do not, so two devices independently
minting a body at the same attribute key lose one subtree. Minting with the row
removes the concurrency entirely.

**The authority is one Durable Object per `(principal, dataId, generation)`.** It
holds that one document, answers `since(stateVector)`, and relays updates
verbatim. ADR-0277's own first answer, refused there, is the shape here.

**The device is not the constraint; the authority is.** ADR-0294 measured a
tab budget of 1,792 MB on an idle iPhone 15 Pro and a per-document cost of
`rows x 5.5 KB + body bytes x 1.8`, which puts roughly 127,000 pages at the
measured 3.2 KB vault mean inside a 1,400 MB working budget. The earlier
per-item rule that priced this at about 100 MB was read from process RSS, which
overstates by two to three times. On the client, one document per database has
roughly fifty times the headroom the largest real collection needs.

The authority does not. A Durable Object runs in a Workers isolate documented at
128 MB "including the JavaScript heap and WebAssembly allocations," and it
hydrates the whole document to answer `since(stateVector)`. **A database is
therefore sized by its authority, not by its device.**

That ceiling was derived when this record was written, from an rss figure, which
is the error ADR-0294 caught. It has since been measured.
`evidence/bench/validate.ts` now reports `heapUsed` beside `rss`, one OS process
per cell, and on notes with prose bodies `applyUpdateV2` into a fresh `Doc`
costs:

```txt
   986 notes   2.7 MB encoded      0.0 MB heap    17.0 MB rss
 5,000 notes  13.9 MB encoded     44.0 MB heap    61.0 MB rss
10,000 notes  27.7 MB encoded    112.1 MB heap   110.2 MB rss
```

The 986-row heap reading is JSC's accounting granularity rather than a free
hydration; from 5,000 rows up the two columns agree. So the finding is the
opposite of the one this record expected: **for a hydrated document, heap and
rss do not disagree, and the four-times rule was right.** The rss overstatement
ADR-0294 found is real for a whole process under load and absent for this one
allocation.

What that changes is the number, downward. Ten thousand notes at the real
vault's mean already costs 112 MB against a 128 MB isolate, so the ceiling is on
the order of **ten thousand rows, not twenty**, and the phone has roughly twelve
times the authority's headroom rather than seven. The measurement is Bun/JSC
rather than workerd, so it estimates the isolate rather than reading it; a
workerd probe is the remaining refinement, and it can only move this number by a
constant.

## Consequences

- Deleted: `store/envelope.ts`, `store/documents.ts`, `sync/hub.ts`,
  `sync/frames.ts`, `sync/authority.ts`, `sync/transport.test.ts`,
  `sync/document-identity.test.ts` and their suites, roughly 4,500 lines, rising
  to about 5,400 with `sync/client.ts` and the port conformance suite.
- Deleted with them, once the store collapsed: the `document` column on the
  durable record, the `retire` op and the `_tombstones` relation, the port's
  `readDocument`/`listDocuments` readers, the controller's `pendingAppends` and
  `pendingDocuments` overlays, and `definition/addresses.ts`'s whole
  `RowAddress` half. A browser record's shape changed, so `STORE_GENERATION`
  goes to `v2` and a `v1` record is stranded rather than migrated.
- Stopped existing: derived row document addresses, the document identity stamp
  and supersession, the tombstone and retirement protocol, `derive` and
  `deriveOnCommit`'s cross-document choreography, the index/record schema split,
  and the address register in the generations ledger.
- The generation model is untouched. A generation is still an exact number,
  created once by importing a folder, never mutated in place, stored as one
  blob, existing if and only if its ledger row exists. None of those sentences
  mentioned Yjs.
- The bootstrap payload is one document's state rather than an envelope of
  addressed sections, so ADR-0292's "it is not one giant Yjs document" no longer
  holds and ADR-0293's multi-section framing collapses to a single payload.
- Harder: every persist folds the whole document, boot hydrates everything,
  every device receives every keystroke of every row, and one object serializes
  every socket for the database. The failure domain is the whole database rather
  than one row, against a 10 GB per-object storage cap.
- Reversing the prose split costs about 5 ms of cold open and 2.7 MB of startup
  bytes on the real 986-note vault (ADR-0212).
- Undo requires that every derived or system write carry a non-null origin,
  forever. Honeycrisp already scopes undo per fragment.
- Nested edits bubble through `changedParentTypes`, so a keystroke now reaches
  the table root's delta path. The current subscriber is a coarse per-commit
  flag; anything later that re-renders a list off that signal fires at typing
  frequency.
- `@y/prosemirror` binds to a nested type without change: it is typed against
  `Y.Type` and makes no root assumption. `apps/honeycrisp/src/lib/editor/Editor.svelte`
  changes by zero lines; its `yxmlfragment` prop name becomes a misnomer.

## Considered alternatives

- **Keep N documents and multiplex them.** Refused. The envelope already does
  this on the client, but the authority must hydrate a document to serve a diff,
  and Yjs hydrates all-or-nothing, so the server splits regardless. The byte-blind
  alternative was measured and rejected in ADR-0282.
- **Yjs subdocuments.** Refused, and measured: 25,000 never-touched subdocs cost
  about 5.1 KB of heap each because `ContentDoc.integrate` eagerly constructs a
  full `Doc` per reference. Subdoc updates never appear in the parent's stream,
  no provider dials them for you, and no API encodes a parent with its subdocs,
  so the envelope would survive re-keyed by guid. It is the N-document design
  with opaque addresses and a new per-row memory floor.
- **Change CRDT engine to one with lazy container materialization.** Deferred,
  not refused. Loro measures dramatically better on this exact axis, but has
  open issues for whole-document compaction memory and shallow-snapshot import
  reproduced on workerd, a 0.x ProseMirror binding with an open content-wipe
  bug, and effectively one maintainer. Revisit; do not bet stored personal data
  on it today.
