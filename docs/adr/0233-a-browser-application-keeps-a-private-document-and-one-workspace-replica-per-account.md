# 0233. A browser application keeps a device document and one account replica per account, and auth chooses whether the replica also opens

- **Status:** Accepted
- **Date:** 2026-08-10
- **Amended by:** [ADR-0259](0259-a-desktop-profile-is-addressed-by-a-server-url-and-principal-pair.md) at the retained account replica address. **Superseded by ADR-0261.** The replica remains retained across sign-out; its client address was `(baseURL, principalId)`.
- **Amended by:** [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md) at the derived connection address. The device document, retained-replica, and sign-out rules remain.
- **Amended by:** [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md) at one clause. "Never automatically copied into, merged with, or deleted because of a workspace action" still holds; a deliberate per-row move a person performs now exists, and both workspaces must be visible in one surface rather than at two routes.
- **Amended by:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at the word only. What this record calls the DEVICE document is now called the LOCAL document, and its address segment is `local` rather than `device`: `openLocal`, `LocalStore`, `epicenter/<databaseId>/local`. ADR-0271 argued the name and won it ("`local/` is an address and will mean this machine forever"), and the store was left saying `device` for one subsystem while the folder said `local` for the other. One concept had two current names. Nothing about the decision changes: the document still never syncs, still has no authority, and is still never merged with a replica. User-facing copy keeps saying "this device", which is the word a person already has (ADR-0244).
- **Amends:** [ADR-0229](0229-a-lens-names-the-store-it-opens-and-opening-is-one-call.md)
  at "the namespace determines the location": the lens still names the
  application, and the caller now also names which document is meant and whose
  it is.
- **Relates:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md)
  (which named private local documents and left their storage undecided),
  [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md)
  (automatic folding is current; workspace compaction is deferred),
  [ADR-0232](0232-a-page-lifetime-is-one-auth-generation-and-a-permanently-denied-sync-stops-for-good.md)
  (a page lifetime is one auth generation, which is what makes a boot-time
  choice complete),
  [ADR-0230](0230-an-auth-client-always-offers-openwebsocket-and-a-model-that-cannot-sync-denies-permanently.md)
  (the permanent denial this record stops interpreting as "signed out"),
  [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (one authority per principal and application, which this record mirrors on
  the device).

- **Amended by:** [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) at the address. Every address this record prints predates the generation segment and the storage epoch, and the word `device` became `local`. What stands is the shape: one document that never joins account sync, plus one retained replica per account.

## Context

Honeycrisp opened one browser store for every generation, signed in or not.
Which document that store held was decided by the first dial: a permanent
denial resolved an unbound store "as a private local document with no sync in
this generation."

That sentence is the defect. The same durable bytes were an account replica
when a dial succeeded and a device document when it did not, so the
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
there: one device database and one account database per application. A
settled product decision reopens it. **Honeycrisp retains an account replica
across sign-out**, so signing back in is instant and offline work made before
signing out is still there afterwards.

Retention is what makes a per-application account database wrong. If account
A's replica is still on the device when account B signs in, a single workspace
database leaves three options, and all of them are worse than an address: B
briefly opens A's bytes; B force-deletes A's retained state, which is the
retention promise broken by the next sign-in; or the database grows a map of
principals inside itself, which is account-scoped storage with the ownership
hidden one level down where no delete, discard, or maintenance action can see it.

## Decision

**A browser application keeps one device document and one retained account
replica per account. The device document opens for every page lifetime, and
authentication chooses whether that generation also opens an account
replica.**

```text
epicenter
└── honeycrisp
    ├── device               device-owned, never syncs, survives everything
    └── account
        ├── <principal A>    A's retained replica of A's current document
        └── <principal B>    B's retained replica of B's current document
```

- The **device** document is device-owned. It never joins workspace sync,
  survives sign-in and sign-out, and is never automatically copied into,
  merged with, or deleted because of a workspace action.
- An **account** replica belongs to one principal. It is this device's copy
  of that principal's current authority document (ADR-0231), it is unavailable
  until its first bootstrap binds it, and every sync verb (bootstrap and
  supersession discard) operates on that one replica alone.

### Three identities, and none of them stands in for another

- The **application namespace** (`so.epicenter.honeycrisp`) says which
  application.
- The **principal id** says whose replica this is. It is the same value the
  authority is addressed by (ADR-0225), so a device's local partition and its
  server partition are one identity rather than two that must agree.
- The **authority document id** says which current Yjs document that replica
  belongs to. Automatic folding does not change it. A future Compact workspace
  action may mint a replacement identity as a separate decision.

The first two are the address. The third lives inside the store because it is
private sync admission metadata, not part of the public application address.
It remains stable for the current document lifetime; a future Compact
workspace action may replace it while keeping the logical address stable.

### The browser names each document by its capability

```ts
const device = await openDevice(lens);
const account = await openAccount(lens, { principalId });
```

The names are not cosmetic. A device document has no authority, outbox,
supersession, or discard operation. An account opener returns a
replica with exactly those capabilities. `openAccount` has nowhere to omit the
principal id, and the IndexedDB database is the address derived from it:

```text
epicenter/<namespace>/device
epicenter/<namespace>/account/<principal id>
```

A namespace is dot-separated lowercase labels and holds no `/`, so the segment
after `epicenter/` is always exactly the application and no address can be read
as another one. The process-local open claim is the same address, so the
device document and any number of accounts' replicas may be open at once,
which is the normal state of a signed-in generation rather than an edge case,
while a second open of any one of them is refused.

An empty principal id is refused as `Unaddressable` rather than addressed. A
boot with no stable account has no account replica, not a nameless one.

### Auth chooses at boot, and only at boot

Every generation opens the device document: it is the application's durable
local space, present whether or not anyone is signed in, and it attaches
nothing, because a device document has no sync and therefore no dial whose
refusal anyone would be reading. A generation with a known principal
(`signed-in` or `reauth-required`) also opens that principal's account
replica and attaches sync to it alone. Both stay open for the whole
generation, and features receive the document they mean to operate on; the
runtime carries no default document that could quietly stand in for either.
A page lifetime is one auth generation (ADR-0232), so the composition never
changes while an application lives; signing in, signing out, or switching
accounts reloads into the next one.

An authenticated generation whose dial is permanently denied is not signed
out. A bound replica stays open and works offline. An unbound one rejects
its boot as unavailable, because only an auth change can repair it, and that
change starts the next generation. An authenticated generation with no usable
principal id rejects its boot the same way. Neither ever falls back to the
device document, and neither ever guesses an address.

A fresh unbound replica that cannot yet bind holds the whole boot behind the
root's gate, device data included, until connectivity lets the first
bootstrap bind it, the dial is permanently denied, or the page lifetime ends.
A partial-ready surface ("use local drafts while the account binds") is
refused: it would make an unbound account a third ready state that every
screen must handle, to serve a window that is sub-second whenever the network
exists. The way back to device-only use is a new generation: signing out.

### Signing out closes a replica, and keeps it

Signing out of A closes A's replica; the device document, open all along,
carries the next generation alone. Signing out deletes
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
  separated the two documents but left an account replica with no owner.

This ownership rename is a clean break too. Opening the device document also
deletes the former `epicenter/<namespace>/private` database; opening one
account replica also deletes that account's former
`epicenter/<namespace>/workspace/<principal id>` database. An unopened former
account database is unreachable by the new model and is deleted if that account
opens again. No old address is read, renamed, or merged.

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
- Supersession can only ever delete
  `epicenter/<namespace>/account/<the signed-in principal>`.
- There is no device-to-account promotion, merge, or copy anywhere in
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

- device work is unchanged after signing in, signing out, and signing into a
  second account;
- the device document is open, readable, and editable during a signed-in
  generation, and its edits land in the device database alone;
- two accounts cannot open or claim one account database, and neither sees
  the other's rows;
- returning to an account reopens its retained replica, offline work included;
- a signed-in workspace starts empty and unavailable until bootstrap, without
  reading or mutating any other document;
- an unbound workspace whose dial is permanently denied is unavailable, and is
  never shown as the device document;
- an authenticated generation with no stable principal id opens no account
  store;
- supersession deletes one account database and leaves the device document and
  every other account's replica intact;
- the device document and two accounts' replicas open concurrently without
  colliding in persistence or claims, and a second open of any of them is
  refused; and
- both superseded storage shapes are deleted at open and read by nothing.
