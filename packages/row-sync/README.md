# @epicenter/row-sync

`@epicenter/row-sync` is the portable row-plane protocol kernel below the
workspace runtime. It owns the facts every deployment must agree on: row intent
folding, exact retry, outcome paging, compaction, baseline acquisition, and
capacity refusal.

It does not know application schemas, Svelte, HTTP, Durable Objects, browser
OPFS, or Yjs root names. The workspace runtime turns product operations into
row intents; the server-side workspace authority folds those intents.

```txt
workspace runtime
  create/update/delete rows, kv, row documents
        |
        v
row-sync protocol
  RowIntent, sealed rounds, tokens, outcomes
        |
        v
workspace authority
  SQLite-backed fold, receipts, paging, compaction, baseline scan
```

The executable companion is `src/protocol-traces.test.ts`. When this README and
that test disagree, trust the test and update the prose.

## One-page reread

The protocol has three numbers because it is tracking three different failure
modes:

```txt
acceptedRound  what the authority accepted from this replica
checkpoint     what global authority outcomes this replica installed
submission     whether this network attempt is fresh enough to believe
```

The three-number story in the executable trace:

```txt
step                 acceptedRound  checkpoint  submission  meaning
enroll               0              0           -           replica identity exists
round 1 accepted     1              1           1           write folded and installed
lost response retry  1              1           2           same digest, no refold
capacity refused     1              1           3           growth blocked, round reusable
delete-only delete   2              2           4           delete folds despite capacity
old retry arrives    -              -           3           inert below watermark 4
round 3 accepted     3              3           5           new live row installed
stale checkpoint     3              1           -           needs baseline acquisition
```

Never collapse `acceptedRound` and `checkpoint` unless the replacement can
explain both exact retry of authored work and paging through everyone else's
confirmed outcomes. Never collapse `submission` into durable progress unless
the replacement can make old capacity refusals harmless.

## RowIntent

The protocol has one mutation vocabulary:

```ts
type RowIntent =
	| { kind: 'create'; table: string; rowId: string; fields: JsonObject; documentUpdate?: Uint8Array }
	| { kind: 'update'; table: string; rowId: string; fields?: FieldChanges; documentUpdate?: Uint8Array }
	| { kind: 'delete'; table: string; rowId: string };
```

Workspace tables, workspace KV, and row-owned documents all reduce to row
intents:

```txt
table row create          -> create row
field edit                -> update row fields
row document edit         -> update row documentUpdate
workspace kv set/unset    -> update the reserved KV row
row delete                -> delete row fields and document state
```

The authority never refuses a semantically valid row intent after accepting its
round. It folds each intent into either an applied outcome or a deterministic
no-op. That keeps exact retry simple: the same sealed image can be resent
without producing duplicate effects.

## One exchange

A normal write exchange looks like this:

```txt
client token:
  replicaId: r1
  acceptedRound: 4
  checkpoint: 10

client sealed round:
  round: 5
  submission: 12
  requestDigest: digest(intents)
  intents: [...]

authority:
  verifies r1 exists
  rejects stale submissions before digest work
  verifies digest
  checks round 5 is the successor of acceptedRound 4
  applies each intent at authority sequences 11, 12, ...
  stores acceptedRound = 5 and submission watermark = 12
  returns outcomes after checkpoint 10

client:
  installs returned outcomes
  stores acceptedRound = 5
  stores checkpoint = returned token checkpoint
```

If the response is lost, the client resends the same `round` and same digest
under a greater `submission`. The authority sees that the round is already
accepted and the digest matches, so it does not refold. It only regenerates the
page response.

If the same accepted round arrives with a different digest, or a future round
skips ahead, the authority returns `replica-fork`. Recovery is a fresh replica
identity.

## Capacity refusal

Deployment storage policy is intentionally outside the protocol kernel. The
hosted deployment resolves a binary growth decision and passes it to the
authority:

```txt
allow        growth can fold
delete-only  growth is refused, all-delete rounds can still fold
```

A capacity refusal advances only the submission watermark. It does not advance
`acceptedRound`, does not move the retry head, and does not fold any intent.
That lets a client reuse the same round number after capacity changes or after
resealing deletes ahead of growth.

An old refusal is authoritative only for its echoed `submission`. If the client
has already issued a greater submission for the same in-flight image, the older
response is stale.

## Outcomes and checkpoints

The authority has one global sequence. Applied intents produce confirmed
outcomes at that sequence:

```txt
sequence 1  row fields, document update, or both
sequence 2  deletion
sequence 3  row fields
```

`checkpoint` is a position in this sequence. A page returns outcomes after the
client checkpoint. The returned token's checkpoint advances to the last included
sequence, or to the authority head when the page is complete.

A row field postimage and document update from the same applied intent share
one sequence and must not be split across pages. That is why outcome paging is
sequence-aware rather than array-slice-only.

## Baseline acquisition

Compaction raises the retention floor by deleting old incremental outcomes and
folding old document update tails into compact baselines. A replica whose
checkpoint falls below the floor cannot catch up by normal pages.

That replica receives:

```txt
baseline-required
  token: same replica and acceptedRound, old checkpoint
  retentionFloor: current floor
```

It then performs stateless `baselineScan` pages over complete live rows in
stable address order. Each row carries fields plus the current document
baseline/update composite. The authority stores no scan session. The replica
uses disposable scratch and promotes the acquired baseline only after it has a
complete replacement.

Authored local intent survives this process. After promotion, the replica
retries its sealed local work above the acquired baseline.

## SQLite adapter

The core sees one SQLite capability:

```ts
type RowSyncSqlite = {
	run(sql, parameters?): void;
	all(sql, parameters?): Row[];
	transaction(run): Result;
};
```

Runtime packages adapt their native engine to that capability:

```txt
sqlite.org OO1 (browser) --+
bun:sqlite ----------------+--> RowSyncSqlite --> workspace authority
DO storage.sql ------------+
```

The caller owns opening and closing the database. The adapter owns only SQL API
translation and transaction entry. The workspace authority owns DDL, replica
receipts, canonical rows, sequence-addressed document logs, outcome compaction,
and baseline scan.

## Exports

- `@epicenter/row-sync`: protocol schemas, parsers, fold, authority, digest,
  admission helpers, and the `RowSyncSqlite` contract.
- `@epicenter/row-sync/browser`: sqlite.org OO1 adapter.
- `@epicenter/row-sync/bun`: `bun:sqlite` adapter.
- `@epicenter/row-sync/durable-object`: SQLite-backed Durable Object adapter.

Transport code validates untrusted client messages with `parseSyncRequest`
and `parseBaselineScanRequest`. Clients validate server messages with the
matching response parsers.

## Verification

```sh
bun run --cwd packages/row-sync typecheck
bun test packages/row-sync
```

The conformance test runs the same authority scenario through all three adapter
surfaces over real SQLite semantics. Browser OPFS lifecycle and deployed
workerd lifecycle remain environment smoke tests; this package test does not
claim to cover either runtime lifecycle.
