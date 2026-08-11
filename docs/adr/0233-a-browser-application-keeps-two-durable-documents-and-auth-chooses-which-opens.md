# 0233. A browser application keeps two durable documents, and auth chooses which opens

- **Status:** Accepted
- **Date:** 2026-08-10
- **Amends:** [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md)
  at "the namespace determines the location": the lens still names the
  application, and the caller now also names which of its documents is meant.
- **Relates:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md)
  (which named private local documents and left their storage undecided),
  [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
  (a page lifetime is one auth generation, which is what makes a boot-time
  choice complete),
  [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md)
  (the permanent denial this record stops interpreting as "signed out").

## Context

Honeycrisp opened one browser store for every generation, signed in or not.
Which document that store held was decided by the first dial: a permanent
denial resolved an unbound store "as a private local document with no sync in
this generation."

That sentence is the defect. The same durable bytes were a workspace replica
when a dial succeeded and a private document when it did not, so the
distinction ADR-0231 drew between the two documents was a runtime mood rather
than a storage fact. Two concrete corruptions follow from it:

- Anonymous work made while signed out lived in the same database a later
  sign-in would bootstrap. The bootstrap's pristine check then concluded
  supersession and the host discarded the file whole, so signing in destroyed
  work made while signed out.
- An authenticated generation whose credential was refused (reauth required,
  a revoked bearer) was shown the same storage as a signed-out one, letting a
  signed-in person edit what is supposed to be the logged-out surface.

## Decision

**A browser application keeps exactly two durable local documents, and
authentication chooses which one a generation opens.**

- The **private** document is device-local. It never joins workspace sync,
  survives sign-in and sign-out, and is never automatically copied into,
  merged with, or deleted because of a workspace action.
- The **workspace** document is this device's replica of the authority's
  current document (ADR-0231). It is unavailable until its first bootstrap
  binds it, and every sync verb (bootstrap, supersession discard, rebuild)
  operates on it alone.

### The opener names the document

```ts
const { data } = await open(lens, { document: 'private' | 'workspace' });
```

The option is required. The IndexedDB database is derived from both names,
`epicenter-store-<namespace>#<document>`, so the two documents can never
share storage and neither can be opened without saying which one is meant.
`#` joins them because a namespace cannot contain it, so no namespace
collides with another namespace's suffixed name.

The process-local open claim is the same derived identity. The claim guards
"two live `Y.Doc`s of one document," and the private and workspace documents
are different documents: both may be open at once (an explicit copy feature
would need exactly that), while a second open of either is still refused.

### Auth chooses at boot, and only at boot

A generation whose auth is signed out, or that has no auth at all, opens the
private document and attaches nothing: a private document has no sync, so
there is no dial whose refusal anyone would be reading. A generation with a
known principal (`signed-in` or `reauth-required`) opens the workspace
document and attaches sync. A page lifetime is one auth generation
(ADR-0232), so the choice never changes while an application lives; signing
in or out reloads into the other document.

An authenticated generation whose dial is permanently denied is not signed
out. A bound workspace stays open and works offline. An unbound one rejects
its boot as unavailable, because only an auth change can repair it, and that
change starts the next generation. Neither ever falls back to the private
document.

### The workspace stays per-application, not per-principal

Signing into a second account with the first account's replica present
declares a document that account's authority never issued, is answered as
retired, and runs the ordinary supersession discard before rejoining from
zero. The identity door already makes account switching safe; a per-principal
database would preserve replicas across switches at the cost of keeping an
account's workspace bytes on a device that signed out of it.

### The pre-split database is deleted, never reinterpreted

`epicenter-store-<namespace>` held anonymous work or a workspace replica,
indistinguishably. Opening either document requests its deletion: never read,
never renamed, never merged, the browser-storage twin of the format wipe in
ADR-0231's cutover. The request never blocks a boot; a delete blocked by
another tab completes when that tab closes, and repeating at every open makes
the deletion certain.

### The stamp refuses a grown store

`isPristine` had one caller: the bootstrap stamping point checked it before
`adoptDocumentIdentity`. The check now lives inside the stamp, which refuses
a store holding state without an identity (`Unstampable`), and the sync
client maps that refusal to `superseded`: discard, never merge, unchanged.
One public verb owns the invariant instead of two sharing it.

## Consequences

- Anonymous work survives signing in, structurally: the signed-in generation
  never opens the database that holds it.
- A signed-in workspace starts empty and unavailable until bootstrap, and
  cannot read or destroy anonymous work while it waits.
- Workspace rebuild and supersession can only ever delete
  `epicenter-store-<namespace>#workspace`.
- There is no private-to-workspace promotion, merge, or copy anywhere in
  sync. A future copy action is an explicit application-level feature.
- Anonymous work from before this record lived in the pre-split database and
  is deleted with it. This branch has no released users; the clean break is
  the whole migration.
- Sync-lab is unaffected: it builds its store in memory with `createStore`
  and never opens browser storage.

## Required checks

Tests must demonstrate that:

- anonymous work remains after signing in, and is unchanged after signing
  back out;
- a signed-in workspace starts empty and unavailable until bootstrap, without
  reading or mutating anonymous work;
- an unbound workspace whose dial is permanently denied is unavailable, and
  is never shown as the private document;
- workspace supersession and rebuild delete only workspace storage;
- the private and workspace documents open concurrently without colliding in
  persistence or claims, and a second open of either is refused; and
- the pre-split database is deleted at open and read by nothing.
