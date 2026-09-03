# 0342. Sign-in is the door to keeping, not to using

- **Status:** Proposed
- **Date:** 2026-09-03
- **Unbuilt:** all of it. No trial opener exists; `openMemory` is Bun-only test support and says so in its own first line. Whispering does not boot at all (ADR-0227), and the three tests it fails still assert the device document ADR-0336 removed.
- **Amends:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md) at "No Epicenter workspace app gates behind sign-in", and at the two mechanisms under it that no longer exist: the signed-out bare IndexedDB document, and the Add / Delete / Keep migration on first signed-in boot. Both were removed by [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) without a record. Everything else in 0088 stands, including the parts live code cites it for: one composition shape, auth read once at boot, a page lifetime is one auth generation, a principal change reloads the document, the account popover is the only auth surface, and `apps/api/ui` is exempt.
- **Relates:** [ADR-0336](0336-an-authority-mints-every-generation-so-every-store-has-an-account.md) (why there is no unowned store to boot into), [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) (what an app-owned file is for), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (a credential a person brings), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) (the desktop answer), [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) (the import path this refuses to need)

## Context

ADR-0088 said an app you cannot open without an account is not local-first, and
it was right about the product. Its mechanism is gone. ADR-0336 made an
authority mint every generation, which deleted the device store, the
`sync === undefined` discriminant, and the second address grammar that a
signed-out document needed. There is nothing left to boot a signed-out person
into.

That was recorded nowhere. ADR-0088 is still `Accepted`, still says no app
gates, and every app that boots today gates: Honeycrisp renders `AccountGate`
on `signed-out`, and Whispering does not boot at all. Nine live citations of
ADR-0088 exist in `packages/` and none of them is about gating. They cite its
corollary, that a page lifetime is one auth generation, which is load-bearing
and unaffected.

The open question is Whispering, whose pitch is bring-your-own-key
transcription. Its keys already live outside the store, in
`device-config.svelte.ts`, so a signed-out person can configure a provider
today. What they cannot do is keep a recording, because keeping is what a store
is and a store now requires an account.

## Decision

**An application without an account works and keeps nothing. Signing in is what
makes a store durable.**

A signed-out application opens an ephemeral store: no address, no generation,
no sync, no persistence, over an in-memory SQLite the page owns. It has every
verb a store has, so the whole application runs on it, and it dies with the
tab. It is not a second address grammar, because it has no address; the
generation opener is untouched.

Signing in mints the first generation and carries nothing over. There is no
migration, no merge, and no prompt, because nothing durable was there to move.

**Two doors, one application.** An entrance that expects a new person proceeds
when signed out; an entrance that expects a returning one gates. Below the
boot they render the same shell, the same provider, and the same domains. A
trial with its own UI is a second application that nobody demos, and it rots.

**The trial keeps the rest of the handle, including `sqlite` and `secrets`.**
Those are scoped by application and device, not by account, so withholding them
would enforce nothing about the account boundary. What the trial promises is
about the person's own data, which lives in the store. An app-owned file holds
what can be re-fetched or rebuilt (ADR-0321), so a trial that caches a provider
list on disk is not lying to anyone. An application that puts a person's own
work in a SQLite file to survive the tab is breaking this rule, and the rule is
the thing to enforce, not the capability.

**A trial holds its blobs in memory, because an OPFS root is an address.**
`createOpfsBlobs` is rooted at a store's address, and an ephemeral store has
none. A trial that wrote audio to OPFS would leave files on disk after the tab
that owned the rows was gone: durable audio nothing points at, which is worse
than losing it. In-memory bounds a trial by RAM, and a trial is a demonstration
rather than a recorder for an afternoon.

**A secret goes to the home its KIND has, and there are two kinds.** A
credential the device holds on an application's behalf, like an OAuth refresh
token bound to this install, is `epicenter.secrets`: scoped by application and
device, never synced, and in a browser it is tab memory on purpose (ADR-0310).
A credential a PERSON brings and expects on every machine, like a provider API
key, is not that, and moving one into `epicenter.secrets` would make a web
build ask for it again after every reload. It lives device-local while there is
no account, which is the layer Whispering already ships, and it belongs in the
owner's vault once there is one (ADR-0074). The trial has no account, so it has
no keyring, so device-local is not a compromise there; it is the only thing
that exists.

**Because a refresh loses everything, a trial has to push its work out.** The
export that already exists is the affordance: copy, download, markdown. A
banner that says nothing is being saved is the other half, and it is not an
error state.

**Desktop is a third answer and needs no store.** With a real folder
(ADR-0337), a signed-out desktop build can keep recordings as files a person
owns. A folder is a working copy, not a store, so this adds no kind.

## Consequences

- A new opener is needed, in `@epicenter/data/browser`, over an in-memory
  SQLite the page owns. `openMemory` cannot serve it: it imports `bun:sqlite`
  and is explicitly not a runtime an application opens.
- Whispering's three failing tests are deleted rather than fixed. They assert a
  signed-out boot into a device document, which is the mechanism this record
  withdraws.
- Nothing is ever imported at sign-in. The import path stays what it is for
  (ADR-0293, ADR-0325): folders and generations, not a rescued trial.
- Honeycrisp is unchanged. An application chooses whether signed-out means a
  gate or a trial; notes people write for years are not a thing to lose on
  refresh, and Honeycrisp keeps its gate.
- A person who refreshes the trial loses it. That is the cost, stated plainly,
  and the reason the export affordance is part of the decision rather than a
  follow-up.
- The signed-out panel in the account popover keeps its job, and gains a
  second: it is where a trial converts.
- Whispering's provider keys do not move onto the handle. `epicenter.secrets`
  is the desktop keychain for a credential an install owns, and Local Mail's
  Gmail token is what that is for. Whispering's keys stay in `deviceConfig`
  until the owner vault lands, and the facade in
  `apps/whispering/src/lib/state/secrets.svelte.ts` is what makes that a
  storage swap rather than a rewrite.
- Nothing in Whispering reads `epicenter.sqlite`, in either mode. It is handed
  over because it costs an allocation and withholding it would fork the handle
  type, not because there is a caller waiting.

## Considered alternatives

- **A persisted trial at a fixed non-account address.** Refused. It survives a
  refresh, which is the one thing the ephemeral store cannot do, and it buys
  that back by reinstating exactly what ADR-0336 deleted: a second grammar in
  the address space, and a merge question at sign-in for every person who ever
  tried the app. The merge has a shape (ADR-0293) but no design, and merging a
  person's recordings is a product surface, not a migration script. If refresh
  loss turns out to cost more than the grammar, that is a new record with this
  one superseded, not a flag added here.
- **Requiring an account outright.** Refused. It is ADR-0088's original
  objection and it still holds: a person should hear the thing work before they
  are asked who they are.
- **A separate trial application.** Refused. Two shells drift, and the one
  nobody uses daily is the one that breaks.
- **Withholding `sqlite` and `secrets` from a trial handle.** Refused. It
  enforces a promise about persistence that the banner makes about the store,
  and it forces two handle types through one shell, which is the drift the
  single-shell rule exists to prevent.
- **Keeping ADR-0088 as written and calling the gates a bug.** Refused. The
  gates are not a regression; the unowned store they replaced was deleted on
  purpose, and a record that describes a mechanism nobody can build is worse
  than one that says what changed.
