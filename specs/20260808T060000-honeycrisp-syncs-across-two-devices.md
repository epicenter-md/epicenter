# Honeycrisp syncs across two devices

- **Status:** Draft
- **Date:** 2026-08-08
- **Relates:** [ADR-0220](../docs/adr/0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md)
  (the transport),
  [ADR-0222](../docs/adr/0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md)
  (the driver, which is the client half and is done),
  [ADR-0223](../docs/adr/0223-a-page-holds-the-store-and-only-three-small-relations-have-to-survive.md)
  (where the store runs).

## What is already true

Honeycrisp runs on the new store. Nothing polls, nothing awaits a read, its
prose is a live `Y.Type`, and a note and its body survive a reload
(`apps/honeycrisp/evidence/runs-on-the-new-store.ts`). `createSyncConnection`
is built and owns every correctness rule a host used to get wrong.

**What is missing is one endpoint.** The new transport's authority exists only
in `apps/sync-lab`, a throwaway unauthenticated Worker. `apps/api` has no route
that speaks it, so there is nothing for Honeycrisp to dial and the two-device
gate cannot be met however the app is wired.

## What this needs

A per-principal authority in `apps/api`. `apps/api` already binds
`EPICENTER_SYNC` to an `EpicenterAuthority`, and that is the SUPERSEDED stack's:
it speaks `exchange` / `publishDocument` / `pullDocument` over
`@epicenter/data/legacy/protocol`. Nothing there speaks the new transport.

The Durable Object itself is ~90 lines and already written twice over: the
adapter in `apps/sync-lab/worker/index.ts` is `openSyncAuthority` plus
`createSyncHub` plus the hibernation handling, and its wake path is the part
worth copying carefully rather than rewriting. It belongs in `packages/server`,
which is AGPL and may depend on MIT `@epicenter/data`, not the other way round.

The route is the part with real decisions in it. `packages/server/src/attach-relay/mount.ts`
is the pattern: a route-owned subprotocol bearer (ADR-0095), with the 101
echoing only the main subprotocol so the credential is never reflected.

Then Honeycrisp's platform leaves grow a `dial` that builds that URL with the
app's bearer, which is the small half, because ADR-0222 left hosts nothing else
to write.

**Do this on a fresh pass, not as a tail.** Binding a new Durable Object class
means a `migrations` entry with `new_sqlite_classes` in a production Worker
config, and this repository already carries one undeployed destructive migration
on the `Room` class. A half-verified second one is not a thing to add at the end
of a long session.

## The open questions, which are the reason this is a Draft

- **What names a partition.** The lab uses `?app=`. Cloud has principals, and
  ADR-0092 says identity is the partition, so a principal and an application
  namespace together presumably name one Durable Object. Nobody has written that
  down for this transport.
- **What the desktop host does.** The `epicenter-host` build currently opens its
  own OPFS like every other build, which is a regression pinned in
  `apps/honeycrisp/src/lib/platform-selection.test.ts`: its notes are no longer
  in the `epicenter.sqlite3` other trusted surfaces read. The shape that
  restores it is the same one, the window as a replica of a store the host owns,
  which means the host serves an authority too. Whether that is the same code as
  Cloud's or a second one is undecided.
- **Whether the stall matters here.** It is still live, reproduced at message 623
  of 2,000 (`packages/data/evidence/workerd/results.md`). The watchdog recovers a
  device in tens of seconds and has NOT been judged against the real failure:
  the one long driven run did not stall. An application workload coalesces on an
  idle timer and looks nothing like that regime, so this may never surface for
  Honeycrisp; nobody has checked.

## The other half of the gate, which is a harness problem

Two devices means two signed-in browser contexts. Honeycrisp authenticates by
OAuth against the hosted API, and this repository has no automated harness for
that; the account work already carries "manual OAuth matrix" as its gate. So
even with the endpoint built, the two-device run is either driven by hand or
needs a test-only credential path decided on purpose rather than improvised.

Worth separating the two claims when this is done: that the ENDPOINT carries a
row between two replicas is provable today in `workerd`, the way
`apps/sync-lab/worker/hibernation.test.ts` already does it. That HONEYCRISP does
it between two signed-in browsers is the harness question above.

## Gates

- Two real devices: write a note on one, see it on the other, with prose.
- Nothing polls. (Already true, and must stay true.)
