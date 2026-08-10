# 0229. A lens names the store it opens, and opening is one call

- **Status:** Accepted
- **Date:** 2026-08-09
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0229 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  at two rows of its naming table and at `bind`. Withdrawn: that one opener per
  runtime must stand in front of a separate `bind` because "the three opens
  share no I/O profile", and that `bind` returns a `Result` because a lens may
  arrive from an installed application folder. Both supports were removed by
  ADR-0227 rather than reasoned away here. What survives unchanged is everything
  the record decided about the lens itself: arktype JSON, nullable-never-optional,
  one type through every door, validation that never gates storage, frozen plain
  rows, and every verb on the table taking the id.
- **Amends:** [ADR-0204](0204-an-app-is-one-reverse-domain-identifier-that-names-every-place-it-exists.md)
  by completing it. Its rule was that one identifier names every place an app
  exists; the store's location was the last place still carrying a second name.
- **Relates:** [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md)
  (a lens is partial and non-authoritative, which is why the word survives),
  [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (one document per application),
  [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the authority is already addressed by namespace),
  [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md)
  (which removed both supports this record retires).

## Context

Opening a store takes two calls and carries two names for one thing. The single
production call site in the repository, and there is exactly one, is:

```ts
// apps/honeycrisp/src/lib/application-platform.ts
const { data, error } = await openBrowserStore({ name: 'honeycrisp' });
// apps/honeycrisp/src/lib/application.ts
const bound = store.bind(honeycrispLens);   // namespace: 'so.epicenter.honeycrisp'
```

`'honeycrisp'` locates the store and `'so.epicenter.honeycrisp'` names the data.
Nothing relates them, so binding Mail's lens to Honeycrisp's store typechecks
and runs. That is the exact defect ADR-0204 exists to remove, surviving in the
one place it could still hide.

ADR-0213 gave three reasons for the split. Two stopped being true last week, and
the third was never a reason for a separate call.

**One opener per runtime, because "the three opens share no I/O profile."**
There are no longer three. ADR-0227 refused hosted web and the extension, and
ADR-0226 left the host owning no application data, which emptied the Bun path:
`openBunStore` has no caller outside this package's own tests, and its own
JSDoc says so. What remains is one live opener and one test opener.

**`bind` returns a `Result` because "a lens may arrive as data from an installed
application folder."** ADR-0227 refused the installed-app plane and deleted
`packages/app`. Every lens is now a TypeScript literal checked by `defineLens`'s
`ValidateLens<L>`, so a lens that does not typecheck does not ship.

**A store holds one application.** This was never an argument for two calls; it
is an invariant the store already asserts in prose and cannot enforce. From
`store.ts`, on `query`:

> It reaches one application's tables because a store holds one application, not
> because anything here scopes by namespace: the statement runs against the whole
> file. That is a bound on WHAT A STORE IS, and it is the only bound there is.

A namespace is already a lifecycle scope everywhere else: one document
(ADR-0215), one file (ADR-0214), one Durable Object (ADR-0225), one folder
(ADR-0208). The opener was the only place it was still a decoration.

## Decision

**A lens names the store it opens. Opening is one call, and its argument is the
lens.**

```ts
// publishable, pure JSON, no runtime dependency (ADR-0168)
export const inbox = defineLens({
  namespace: 'so.epicenter.mail',
  title: 'Inbox',
  tables: { messages: { subject: 'string', unread: 'boolean' } },
});

import { open } from '@epicenter/data/browser';
const { data: mail } = await open(inbox);

mail.messages.create({ subject: 'hi', unread: true });
mail.query`SELECT * FROM messages WHERE unread`;
```

### The namespace determines the location

`name` and `directory` are deleted as parameters. A browser store's IndexedDB
database and a Bun store's directory are derived from `lens.namespace`, so the
mismatch above is not something a caller must avoid; it is something a caller
cannot express.

### The runtime stays in the subpath, never in the identifier

`open` is the name at `@epicenter/data/browser` and at `@epicenter/data/bun`.
The subpath already says which adapter, and `openBrowserStore` said it twice.
One runtime survives ADR-0227 anyway, so the word in the identifier names a
distinction the product no longer makes.

### Opening one namespace twice in one process is an error

`open` refuses a namespace it already holds open, with
`StoreError.AlreadyOpen`. Two opens would be two `Y.Doc`s of one document that
cannot see each other's writes, converging through storage under last-writer-wins:
work disappears, converged, with no error and nothing to retry. That is the
failure class ADR-0216 deleted the chosen-id door to make unreachable, and this
is the same move.

The registry that makes the refusal possible is legitimate under ADR-0203 rather
than a platform forming: one file and one document with two claimants is
genuinely contended, and contention earns a lifecycle. It is process-local, it
holds namespaces rather than handles, and disposing a store releases its entry.

### File-level verbs live under one reserved key

```ts
mail.messages.create({ … });      // the data
mail.$store.pressure();           // the file
mail.$store.sync;
await mail.$store[Symbol.asyncDispose]();
```

`pressure`, `sync`, `stateVector`, `encodeStateSince`, `applyRemote`,
`hasUnresolvedDependencies`, `onLocalWork`, `onCommitted` and disposal are about
the file rather than the data. Merging them flat beside the tables would reserve
nine table names, and table names come from users. ADR-0213 already reserves
`query` for that reason and cites Jazz moving everything under `$jazz` in 0.18.0
after hitting it; this is the same answer one level up. One reserved key costs
one name instead of nine.

### `lens` keeps its name

The word says the view is partial and non-authoritative, which ADR-0160 states
outright: multiple lenses may interpret one namespace and none is canonical.
That is the fact a reader most needs to hold once a second application reads the
same rows. Renaming it `database` or `schema` would imply ownership of rows
another application also writes, and ADR-0168 already refuses `schema`.

### What is deleted

`openBunStore`, `openBrowserStore`, the `name` and `directory` parameters,
`Store.bind`, `Store.bindUnknown`, and `Store` from the public surface.
`createStore` stays internal to the package.

## Consequences

- **An application's whole boot is one await per namespace**, with no second
  call, no second name, and no composition object:

  ```ts
  const { data: mail }  = await open(inbox);
  const { data: notes } = await open(backlinks);
  ```

- **The multi-namespace model from ADR-0160 becomes expressible rather than
  theoretical.** One namespace is one store, so an application that reads a
  second application's data opens a second store, and the two are as separate on
  disk, in memory, and at the authority as they already were.
- **Relensing costs a reopen.** Tests that rebind a second lens to a live store
  to prove the projection rebuilds now close and reopen. That is what a release
  upgrade already does, so the test shape follows the product shape rather than
  the other way round.
- **`bindUnknown` goes, and with it the last consumer of `parseLens` on the hot
  path.** A lens arriving as unknown data was the installed-app case; ADR-0227
  refused it. `parseLens` stays exported for the inspector, which reads lenses it
  did not author.
- **`$store` is a reserved key on every bound application**, beside `kv` and
  `query`. Three reserved names, all documented, none of them plausible as a
  table a person would name.
- **What this forecloses:** a second name for a store's location, an opener that
  takes a path, a lens bound to a store it does not name, two lenses over one
  namespace in one process, and `lens.open()` as a method.

## Considered alternatives

- **Keep `bind`, so two lenses can share one document.** The strongest
  objection, and it fails on the facts: the store already holds one application
  by its own contract, so two lenses on one store share a flat table-root space
  and collide silently if both declare `notes`. Every production call site binds
  exactly once. The case `bind` protected is served by one wider lens.
- **Merge the file verbs flat beside the tables.** Rejected above: nine reserved
  table names against one, in a namespace whose names come from users.
- **`lens.open()` as a method.** Rejected outright. A lens must survive
  `JSON.stringify` and `JSON.parse` and be authorable as a hand-written
  `lens.json` (ADR-0168), and a method on it breaks that in the one way the
  record cannot tolerate.
- **Keep `openBrowserStore` and derive only the name from the lens.** Rejected:
  it fixes the two-names defect and keeps the second call, which is the half of
  the problem with no argument left behind it.
- **Rename `lens` to `database`.** Considered because the handle really is one.
  Rejected on ADR-0160's grounds: the word is what tells a reader their
  interpretation is partial and that another application may hold a different one
  over the same rows.
