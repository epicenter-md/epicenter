# Honeycrisp is the first app on the new store, as a clean break

- **Status:** In Progress
- **Date:** 2026-08-08
- **Relates:** [ADR-0215](../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (one document, synchronous surface),
  [ADR-0220](../docs/adr/0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md)
  (the transport),
  [ADR-0219](../docs/adr/0219-a-deleted-row-is-removed-and-the-presence-flag-is-retired.md).
- **Decided:** clean break. Honeycrisp itself moves; no parallel surface is
  stood up beside it. A parallel demo would be too easy on the API to teach
  anything, and the point of picking a real app is that it pushes back.

## Why this app, and why now

The transport is settled and evidenced. The developer-facing surface is not, and
guessing at it produces an API nobody has held. Honeycrisp is about 2,500 lines
of real application code, is desktop-first so durable SQLite already works, and
is the app whose shape drove ADR-0215's decisions in the first place.

## What the old stack actually made Honeycrisp do

Read before designing anything, because the replacement is mostly deletion:

- **Reactivity is a manual refresh.** `routes/state/notes.svelte.ts` holds
  `$state.raw<Note[]>` and an async `refresh()` that re-scans every table. Every
  mutation has to remember to call it, and a `refreshGeneration` counter exists
  purely to discard the results of races between overlapping refreshes.
- **Documents are polled.** `lib/document-polling.ts` pulls each open note on a
  one-second interval through the old HTTP row-document path, with its own error
  taxonomy for "the pull failed" against "the handle refused".
- **Everything is asynchronous**, because the old surface is.

## The target

```ts
const store = await openBunStore({ directory });     // once, at boot
const db = store.bind(honeycrispLens);                // synchronous thereafter

db.notes.list();                                      // no await
db.notes.document(id).get('editor', 'text');          // a live type, no polling
```

Notes are read synchronously from the projection. A note's prose is a live
`Y.Type` an editor binds to directly. Nothing polls anything.

## Waves

Each wave leaves the app running. Ordered so the piece with genuine unknowns
comes first, because it is the only one that can change what the rest means.

### Wave 1: the prose binding, which is mostly already done

**This wave was planned as a hand-rolled CodeMirror binding and grounding
refuted that.** Recording it, because the wrong version made this look like the
riskiest wave when it is the cheapest.

Honeycrisp does not use CodeMirror. It uses ProseMirror, `@y/prosemirror` is
already a dependency, and `src/lib/editor/Editor.svelte` already takes its
target as a prop:

```ts
yxmlfragment: Y.Type            // Editor.svelte:225
configureYProsemirror({ ytype: yxmlfragment })(...)
```

The new store's `db.notes.document(id).get('editor')` returns exactly that. And
ADR-0215 already measured `@y/prosemirror@2.0.0-6` bound to a NESTED CONTAINER
working correctly: the row's `title` and `tags` survive and the prose reads back.
What it measured failing was binding to the ROW itself, which nothing here does.

So this is wiring, not invention. The CodeMirror sentence in ADR-0215 describes
an alternative that was never needed for this app.

**Consequence for the whole plan: the risky unknown is gone, so wave order no
longer needs to protect against it.** Waves 2 and 3 are now the real work.

### Wave 2: per-table subscription carrying row ids

**This wave was drafted as a single whole-document signal and the research
overturned it.** Recording why, because the wrong version was reasonable and
will be proposed again.

The draft argued that a finer signal would be a lie, since `applyRemote` rebuilds
EVERY bound table's projection. Two things were wrong with that:

- **The premise was too broad.** `get`, `list` and `ids` read the CRDT directly
  and are correct the instant a transaction closes. Only `db.query` reads the
  projection. So a coarse projection rebuild does not make row-level knowledge
  unavailable, it only makes the SQL view lag.
- **The store's own comment inherited a conclusion.** It says `observeDeep`
  reports a nested row's edit as an event on the table root with `keysChanged`
  empty, so the observer cannot name the row. That sentence is TRUE and worth
  keeping as a warning. The conclusion drawn from it, that nothing can name the
  row, is false: the same type exposes a `'delta'` event that names it.

Verified independently on `@y/y@14.0.0-rc.24`, with a control that a write to a
different table fires nothing:

```txt
local field edit      delta names the row
prose inside !doc     delta names the row
remote applyUpdateV2  delta names the row
```

So the shape is ADR-0187's, unchanged: `TableInvalidation` is
`{scope:'rows', rowIds}` or `{scope:'table'}`, per table, one call per commit.
Reuse `packages/lens/src/observation.ts` verbatim; its grouping and dedup are
exactly what a delta-fed producer needs. ADR-0187 rejected a void subscription
because "simplicity here is paid for on every commit, forever", and that
reasoning survives the store transition because the same information is still
free.

Cost is proportional to the change rather than to the table: on 20,000 rows, one
edited row costs 0.88 ms against 0.15 ms with no subscriber, and 2,000 edited
rows cost 12 ms.

**One hazard, measured, and it dictates the implementation.** The delta event
fires SYNCHRONOUSLY inside `applyUpdateV2`, before `persist()` has rebuilt the
projection. Reproduced: at notify time the CRDT reports 2 rows while `db.query`
still reports 1, and they agree only once `applyRemote` returns. So row ids must
be collected during the transaction and flushed AFTER `persist()` commits, or a
subscriber will read a stale SQL view.

**No producer for `{scope:'table'}`.** That arm existed for carrier gaps in the
old multi-process replica, and an in-process store has no carrier and therefore
no gap. Keep the arm, since consumers already handle it and a future proxy will
need it, but nothing will emit it.

Deletes `refreshGeneration` and every manual `refresh()` call site.

### Wave 3: sync that owns its own correctness

The hand-rolled connect loop is partly legitimate: the client deliberately owns
no socket, which is why every timing rule is testable without a network, and
socket construction genuinely differs per host.

What is not legitimate is that **correctness lives in the caller's loop**.
Reconnecting on `status().needsResync` is a correctness requirement, and a fuzz
proved that omitting it wedges a device permanently while everything still looks
healthy. A rule like that cannot be opt-in per application.

Split it: the host owns transport CONSTRUCTION (how to make a socket, backoff,
auth), the library owns transport CORRECTNESS (cursor in the URL, pump order,
reconnect on close, reconnect on `needsResync`). `createSyncClient` stays exactly
as it is underneath, so tests keep driving it with no network. Additive.

### Wave 4: Honeycrisp moves

Replace the workspace wiring, make the state modules synchronous, and delete:

- `lib/document-polling.ts` and its test
- `refreshGeneration` and the manual `refresh()` discipline
- every `await` on a read

### Wave 5: the package exports stop lying

`@epicenter/data`'s main export still points at the superseded stack. A developer
importing `@epicenter/data` today gets `replica/`, `protocol/v1/` and
`sync-supervisor`; the new store is only reachable at `@epicenter/data/store`.
Whispering and vocab still run on the old stack, so this is a rename and a
narrowing rather than a deletion, until they move too.

## Gates

- The two-device run, on Honeycrisp rather than on the throwaway lab: write a
  note on one device, see it on the other, with prose.
- `store.pressure()` reported somewhere visible, so the one number worth watching
  is watched.
- Nothing polls.

## What this does NOT do

- **Whispering and vocab do not move.** They stay on the old stack until
  Honeycrisp has proved the surface.
- **No browser store.** Honeycrisp is desktop-first, so ADR-0214's deferral does
  not block this, and adding it here would be scope nobody asked for.
- **No end-to-end encryption.** The door stays open at zero cost as long as the
  authority never reads bytes; walking through it is not this work.
