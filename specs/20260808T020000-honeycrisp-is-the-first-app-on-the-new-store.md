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
  (the connection driver, landed),
  [ADR-0223](../docs/adr/0223-a-synchronous-store-needs-a-runtime-that-can-write-durably-without-awaiting-and-a-browser-page-is-not-one.md)
  (why the move is blocked).
- **Decided:** clean break. Honeycrisp itself moves; no parallel surface is stood
  up beside it.

## Where this stands

The developer-facing surface the app was picked to force is built. What is not
settled is where Honeycrisp's store can run at all, and that turned out to be a
host question rather than a store question.

**Landed.** The per-table subscription carrying row ids (ADR-0221) and the
connection driver that owns its own correctness (ADR-0222), including the
watchdog and `store.onLocalWork`. The lab runs on the driver, which is what makes
"a host writes only a dial" a demonstration rather than a claim.

**Blocked.** Honeycrisp's own move. The plan assumed a browser store was a matter
of writing one; measured, a browser page cannot take a synchronous handle to
durable storage at all (ADR-0223), and a Tauri WebView is a browser. So the
opener Honeycrisp needs does not exist and cannot be written as an opener.

**Not started.** `@epicenter/data`'s main export still points at the superseded
stack. Deliberately: narrowing it to the new store while no application in this
repository can open one would make the front door name something unusable, and it
is 43 files of churn with nothing to verify against.

## The open fork, which is the whole of what is left to decide

ADR-0223 names the shape: a page that wants the synchronous surface is a REPLICA
of a durable store rather than an owner of one, holding `createStore` over an
in-memory SQLite plus a `createSyncConnection` to whoever owns the file. Every
piece of that exists. What does not exist is the answer to **who owns
Honeycrisp's durable file on the desktop**, and there are three candidates:

- **The Epicenter host process.** It is already Bun, `openBunStore` works there
  unchanged, and `openSyncAuthority` and `createSyncHub` are already built and
  deployed, so a window becomes a replica of a local authority using the same
  transport as the cloud. Costs: only the `epicenter-host` build gets it, and
  Honeycrisp's own Tauri shell (`bun dev:honeycrisp`) gets nothing.
- **Honeycrisp's own Tauri shell, through Rust.** Reaches the standalone bundle,
  which is the build people actually install. Costs a Rust SQLite bridge and a
  second implementation of the authority's socket.
- **A dedicated worker in the page.** No host at all, works in the web SPA and
  every WebView alike, and is where the superseded stack already put storage.
  Costs the most machinery: the worker owns the durable log, the page owns the
  live `Y.Doc`, and the two are a replica pair rather than a proxy, so the
  page's writes reach durability asynchronously and `persist`'s
  poison-on-failure becomes an alarm the app surfaces rather than a returned
  error.

The third is the only one that reaches every surface, and it is the only one that
weakens a property ADR-0215 currently has. That trade is the decision.

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
must be created as
`db.notes.create(fields, { document: ['body'] })`, which is also what keeps two
devices first-opening one note from each minting a root and losing one.

## Gates, unchanged

- The two-device run, on Honeycrisp rather than on the throwaway lab: write a
  note on one device, see it on the other, with prose.
- `store.pressure()` reported somewhere visible.
- Nothing polls.

## What this does NOT do

- **Whispering, vocab, tab-manager and skills do not move.** They are all browser
  surfaces, so ADR-0223 governs every one of them, and they stay on the
  superseded stack until the fork above is decided.
- **No end-to-end encryption.** The door stays open at zero cost as long as the
  authority never reads bytes; walking through it is not this work.
