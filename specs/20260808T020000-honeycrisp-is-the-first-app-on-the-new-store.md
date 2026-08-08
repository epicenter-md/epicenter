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

### Wave 1: the prose binding

**The only part with real unknowns, and a notes app cannot ship without it.**
ADR-0215 established that no Yjs 14 editor binding is published: `@y/codemirror`
is a `0.0.0-0` placeholder and `y-codemirror.next` targets Yjs 13. ProseMirror is
worse than absent, because binding it to a row silently overwrites the row's own
fields with schema defaults and that corruption synchronises.

So this is hand-rolled, and ADR-0215 already scoped it: positional insert and
delete, change observation, and remote edits arriving as `{retain, insert}`
deltas, which is what a CodeMirror `ChangeSet` is built from.

Do this first. If it turns out hard, it changes what an end-to-end demo means.

### Wave 2: one signal, when the projection changes

Not per-table and not per-row. On a remote update the store already rebuilds
EVERY bound table's projection, because a remote update does not say which rows
it touched, so a finer subscription would report something the store does not
know.

The signal is **"the projection changed"**, which is precisely what the store
does know: store verbs and remote updates touch it, and prose written into a
row's document does not. Prose needs no signal at all, because the editor is
bound to a live type.

Deletes `refreshGeneration` and every manual `refresh()` call site.

**Pending:** an agent is excavating `TableInvalidation` and
`createInvalidationDispatcher` in `packages/lens`, every existing consumer, and
what was tried and abandoned before. It is also verifying the claim in
`store.ts` that `observeDeep` cannot name the row that changed. If that claim is
false, per-row is available and this wave should be reconsidered.

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
