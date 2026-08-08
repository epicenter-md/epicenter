# Honeycrisp syncs across two devices

- **Status:** Draft
- **Date:** 2026-08-08
- **Relates:** [ADR-0220](../docs/adr/0220-the-authority-keeps-a-snapshot-and-a-tail-and-a-deletion-becomes-real.md)
  (the transport),
  [ADR-0222](../docs/adr/0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md)
  (the driver, which is the client half and is done),
  [ADR-0223](../docs/adr/0223-a-page-holds-the-store-and-a-worker-holds-its-durable-log.md)
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

A per-principal authority in `apps/api`, which is `openSyncAuthority` plus
`createSyncHub` in a Durable Object, routed by identity rather than by a query
parameter. The lab's `worker/index.ts` is thirty lines over exactly those two
and is the shape; what it does not have is auth, a per-principal DO name, a
wrangler migration, or any thought about what a partition costs.

Then Honeycrisp's platform leaves grow a `dial` that builds that URL with the
app's bearer, which is the small half, because ADR-0222 left hosts nothing else
to write.

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

## Gates

- Two real devices: write a note on one, see it on the other, with prose.
- Nothing polls. (Already true, and must stay true.)
