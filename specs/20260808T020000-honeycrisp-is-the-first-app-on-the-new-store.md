# Honeycrisp is the first app on the new store, as a clean break

- **Status:** In Progress
- **Date:** 2026-08-08
- **Relates:** [ADR-0215](../docs/adr/0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (one document, synchronous surface),
  [ADR-0220](../docs/adr/0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md)
  (the transport),
  [ADR-0221](../docs/adr/0221-a-table-names-the-rows-a-commit-touched-and-says-so-after-the-projection-commits.md)
  (the subscription, landed),
  [ADR-0222](../docs/adr/0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md)
  (the connection driver, landed).
- **Decided:** clean break. Honeycrisp itself moves; no parallel surface is stood
  up beside it.

## Where this stands

**Landed.** The per-table subscription carrying row ids (ADR-0221) and the
connection driver that owns its own correctness (ADR-0222), including the
watchdog and `store.onLocalWork`. The lab runs on the driver, which is what makes
"a host writes only a dial" a demonstration rather than a claim.

**Remaining.** Waves 1, 4 and 5: the prose binding, Honeycrisp's move, and the
package export. None of them is started.

## The browser store, which is the only thing standing between here and Wave 4

A page cannot take a synchronous handle to durable storage. Measured in a real
Chromium on a secure origin, with the dedicated-worker arm as a control that must
succeed (`packages/data/evidence/browser/sync-access-handle.ts`):

```txt
context           available  detail
main thread       false      createSyncAccessHandle is not a function
dedicated worker  true       9 bytes written
```

**That constrains where the durable log lives and nothing else.** It was briefly
read here as meaning a page cannot host the store at all, which is false, and the
throwaway lab refutes it by running: `apps/sync-lab/ui/main.ts` is `createStore`
over sqlite-wasm `:memory:` on a browser main thread, deployed and working. The
store needs a synchronous HANDLE, not synchronous DURABILITY. `createStore`
touches the database in three places, `applyStoreSchema` and `readUpdates` at
construction and then `transaction`/`all`, and every read a person makes (`get`,
`list`, `ids`, `document`) comes from the `Y.Doc` in memory. SQLite is a
write-behind log and a query cache, not the read path.

So `openBrowserStore` is:

- **In the page:** sqlite-wasm `:memory:`, handed to `createStore` unchanged.
- **In a dedicated worker:** the OPFS log, holding the durable update log, the
  outbox and the cursor. Not the projection, which is derived and cheap to
  rebuild, and mirroring it would flood the port on every remote update.
- **At boot:** `openBrowserStore()` is already allowed to be async, like
  `openBunStore`. Read the log out of the worker, write it into the in-memory
  database, then construct the store, which hydrates from it exactly as it does
  on Bun.
- **On every durable write:** forward the same bytes to the worker to append.

### The one thing that genuinely changes, and it needs deciding

`persist` currently POISONS the store when durable storage refuses, because
memory and storage have diverged and continuing would publish work that was never
committed. With the log behind a port, that refusal arrives after the write has
already returned `Ok`.

The proposal is that it becomes an ALARM rather than a returned error, in the
same shape as `hasUnresolvedDependencies`: a reader on the store that says this
device's durable copy is behind, which the application surfaces. Nothing is lost
when it fires, because the `Y.Doc` still holds the work and the outbox still owes
it to the authority; what is lost is the guarantee that a reload sees it.

That is the decision to make before this is built. It is a seam, not a fork, and
it does not need a host to own anything.

### What this is NOT

Not a proxy. The superseded stack put the whole replica in a worker and made the
page an asynchronous client of it, which is why `src/browser.ts` is 700 lines and
why every read in Honeycrisp is awaited today. Here the worker holds bytes it
never interprets and the page holds the document, so the surface stays
synchronous and the worker's protocol is append and read-all.

## What Honeycrisp does today, for whoever picks this up

The replacement is mostly deletion, and none of it has happened yet:

- **Reactivity is a manual refresh.** `routes/state/notes.svelte.ts` and
  `folders.svelte.ts` each hold `$state.raw` rows and an async `refresh()` that
  re-scans the table, with a `refreshGeneration` counter whose only job is to
  discard the results of races between overlapping refreshes. ADR-0221's
  `subscribe` replaces all of it.
- **Documents are polled.** `lib/document-polling.ts` pulls each open note on a
  one-second interval, with its own error taxonomy for "the pull failed" against
  "the handle refused". It and its test are deleted outright; a note's prose
  becomes the live `Y.Type` from `db.notes.document(id).get('body')`.
- **Everything is asynchronous**, because the old surface is.

The prose binding itself is wiring rather than invention, and this is worth
saying because the plan had it as the risky unknown. Honeycrisp uses ProseMirror,
`@y/prosemirror` is already a dependency, and `lib/editor/Editor.svelte` already
takes its target as a `yxmlfragment: Y.Type` prop handed to
`configureYProsemirror({ ytype })`. `document(id).get('body')` returns exactly
that, and ADR-0215 already measured `@y/prosemirror` bound to a NESTED CONTAINER
working. Do not hand-roll a binding.

One thing the store now makes visible: `document(id).get(name)` CREATES on miss,
so a row whose roots were not named at `create` invalidates on first open. Notes
must be created as `db.notes.create(fields, { document: ['body'] })`, which is
also what keeps two devices first-opening one note from each minting a root and
losing one.

## Gates, unchanged

- The two-device run, on Honeycrisp rather than on the throwaway lab: write a
  note on one device, see it on the other, with prose.
- `store.pressure()` reported somewhere visible.
- Nothing polls.

## What this does NOT do

- **Whispering, vocab, tab-manager and skills do not move.** They stay on the
  superseded stack until Honeycrisp has proved the surface.
- **No end-to-end encryption.** The door stays open at zero cost as long as the
  authority never reads bytes; walking through it is not this work.
