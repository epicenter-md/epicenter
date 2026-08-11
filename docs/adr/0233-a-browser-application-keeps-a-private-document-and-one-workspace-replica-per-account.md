# 0233. A browser application keeps a private document and one workspace replica per account, and auth chooses which opens

- **Status:** Accepted
- **Date:** 2026-08-10
- **Amends:** [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md)
  at "the namespace determines the location": the lens still names the
  application, and the caller now also names which document is meant and whose
  it is.
- **Relates:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md)
  (which named private local documents and left their storage undecided),
  [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
  (a page lifetime is one auth generation, which is what makes a boot-time
  choice complete),
  [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md)
  (the permanent denial this record stops interpreting as "signed out"),
  [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (one authority per principal and application, which this record mirrors on
  the device).

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

Splitting the two documents fixes both, and this record's first form stopped
there: one private database and one workspace database per application. A
settled product decision reopens it. **Honeycrisp retains a workspace replica
across sign-out**, so signing back in is instant and offline work made before
signing out is still there afterwards.

Retention is what makes a per-application workspace database wrong. If account
A's replica is still on the device when account B signs in, a single workspace
database leaves three options, and all of them are worse than an address: B
briefly opens A's bytes; B force-deletes A's retained state, which is the
retention promise broken by the next sign-in; or the database grows a map of
principals inside itself, which is account-scoped storage with the ownership
hidden one level down where no delete, discard, or rebuild can see it.

## Decision

**A browser application keeps one device-owned private document and one
retained workspace replica per account, and authentication chooses which one a
generation opens.**

```text
epicenter
└── honeycrisp
    ├── private              device-owned, never syncs, survives everything
    └── workspace
        ├── <principal A>    A's retained replica of A's current document
        └── <principal B>    B's retained replica of B's current document
```

- The **private** document is device-owned. It never joins workspace sync,
  survives sign-in and sign-out, and is never automatically copied into,
  merged with, or deleted because of a workspace action.
- A **workspace** replica belongs to one principal. It is this device's copy
  of that principal's current authority document (ADR-0231), it is unavailable
  until its first bootstrap binds it, and every sync verb (bootstrap,
  supersession discard, rebuild) operates on that one replica alone.

### Three identities, and none of them stands in for another

- The **application namespace** (`so.epicenter.honeycrisp`) says which
  application.
- The **principal id** says whose replica this is. It is the same value the
  authority is addressed by (ADR-0225), so a device's local partition and its
  server partition are one identity rather than two that must agree.
- The **authority document id** says which current Yjs document that replica
  belongs to. It changes on rebuild.

The first two are the address. The third lives inside the store, because
rebuild changes it: a rebuilt workspace stays at the same address while its
contents are discarded and re-downloaded.

### The opener names the document and its owner

```ts
await open(lens, { document: 'private' });
await open(lens, { document: 'workspace', principalId });
```

The argument is a union, so an account-less workspace replica is not a value
the API can express, and the IndexedDB database is the address derived from
all of it:

```text
epicenter/<namespace>/private
epicenter/<namespace>/workspace/<principal id>
```

A namespace is dot-separated lowercase labels and holds no `/`, so the segment
after `epicenter/` is always exactly the application and no address can be read
as another one. The process-local open claim is the same address, so the
private document and any number of accounts' replicas may be open at once (an
explicit copy feature would need exactly that), while a second open of any one
of them is refused.

An empty principal id is refused as `Unaddressable` rather than addressed. A
boot with no stable account has no workspace, not a nameless one.

### Auth chooses at boot, and only at boot

A generation whose auth is signed out, or that has no auth at all, opens the
private document and attaches nothing: a private document has no sync, so
there is no dial whose refusal anyone would be reading. A generation with a
known principal (`signed-in` or `reauth-required`) opens that principal's
workspace replica and attaches sync. A page lifetime is one auth generation
(ADR-0232), so the choice never changes while an application lives; signing
in, signing out, or switching accounts reloads into a different document.

An authenticated generation whose dial is permanently denied is not signed
out. A bound workspace stays open and works offline. An unbound one rejects
its boot as unavailable, because only an auth change can repair it, and that
change starts the next generation. An authenticated generation with no usable
principal id rejects its boot the same way. Neither ever falls back to the
private document, and neither ever guesses an address.

### Signing out closes a replica, and keeps it

Signing out of A closes A's replica and opens the private document. It deletes
nothing. Signing back in as A reopens A's replica with everything in it,
including offline work made before the sign-out, and its stamped document id
decides at the next dial whether that work is still current or the replica is
superseded. Signing in as B opens B's replica, which is a different database
that A's bytes are not in and that no verb of A's can name.

### Storage from before the address is deleted, never reinterpreted

Two superseded shapes, and neither is read:

- `epicenter-store-<namespace>`, the single database from before an
  application had two documents, which held anonymous work or a workspace
  replica indistinguishably.
- `epicenter-store-<namespace>#private` and `#workspace`, the split that
  separated the two documents but left a workspace replica with no owner.

Opening any document requests both deletions: never read, never renamed,
never merged, the browser-storage twin of the format wipe in ADR-0231's
cutover. The request never blocks a boot; a delete blocked by another tab
completes when that tab closes, and repeating at every open makes the deletion
certain.

### The stamp refuses a grown store

`isPristine` had one caller: the bootstrap stamping point checked it before
`adoptDocumentIdentity`. The check now lives inside the stamp, which refuses
a store holding state without an identity (`Unstampable`), and the sync
client maps that refusal to `superseded`: discard, never merge, unchanged.
One public verb owns the invariant instead of two sharing it. It is a
defensive assertion at the bootstrap boundary, not product language.

## Consequences

- Anonymous work survives signing in, structurally: the signed-in generation
  never opens the database that holds it.
- A second account cannot read, mutate, or discard the first account's
  replica, structurally: it never opens that database either. Account
  switching costs no download and destroys no retained state.
- A signed-in workspace starts empty and unavailable until bootstrap, and
  cannot read or destroy anonymous work or another account's work while it
  waits.
- Workspace rebuild and supersession can only ever delete
  `epicenter/<namespace>/workspace/<the signed-in principal>`.
- There is no private-to-workspace promotion, merge, or copy anywhere in
  sync. A future copy action is an explicit application-level feature.
- Retained replicas accumulate per account signed into on a device. Reclaiming
  them is a deliberate product action (a "remove this account's local data"
  affordance), not something a boot may do on its own, because a boot cannot
  tell an abandoned account from one that is offline.
- Storage from before this record is deleted with it. This branch has no
  released users; the clean break is the whole migration.
- Sync-lab is unaffected: it builds its store in memory with `createStore`
  and never opens browser storage.

## Required checks

Tests must demonstrate that:

- private work is unchanged after signing in, signing out, and signing into a
  second account;
- two accounts cannot open or claim one workspace database, and neither sees
  the other's rows;
- returning to an account reopens its retained replica, offline work included;
- a signed-in workspace starts empty and unavailable until bootstrap, without
  reading or mutating any other document;
- an unbound workspace whose dial is permanently denied is unavailable, and is
  never shown as the private document;
- an authenticated generation with no stable principal id opens no workspace
  store;
- supersession and rebuild delete one account's workspace database and leave
  the private document and every other account's replica intact;
- the private document and two accounts' replicas open concurrently without
  colliding in persistence or claims, and a second open of any of them is
  refused; and
- both superseded storage shapes are deleted at open and read by nothing.
