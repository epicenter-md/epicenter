# Handoff: move Honeycrisp onto the new Epicenter store

Paste everything below the line into a fresh Claude Code session. It is written
for a reader who cannot see the conversation that produced it.

This file is scratch, not a record. Delete it when the work lands.

---

You are moving Honeycrisp onto Epicenter's new Yjs store, as a clean break. The
transport underneath is built, deployed and evidenced; the developer-facing
surface is not, and Honeycrisp is the app chosen to force its shape.

## Where

    worktree  /Users/braden/Code/epicenter/.claude/worktrees/local-mail-storage-followup
    branch    claude/value-is-a-named-row   (clean, unpushed, 200 commits ahead of main)

`bun test packages/data packages/lens` is 462 green. `bun run --cwd packages/data
typecheck`, `bun run --cwd apps/sync-lab typecheck`, `bun run
scripts/check-doc-hygiene.ts` and `bun run scripts/check-doc-paths.ts` are all
clean. Keep them that way.

## Read first, in this order

    specs/20260808T020000-honeycrisp-is-the-first-app-on-the-new-store.md   <- the plan, with waves
    docs/adr/0215-*.md    one document per app, a row owns a container, and how its roots are allocated
    docs/adr/0220-*.md    the authority keeps a snapshot and a tail
    docs/adr/0218-*.md    the authority reads nothing
    docs/adr/0219-*.md    a deleted row is removed
    packages/data/src/store/store.ts        the surface you will wire
    packages/data/src/sync/client.ts        the client half of the transport
    apps/honeycrisp/src/routes/state/notes.svelte.ts   what the app does today
    apps/honeycrisp/src/lib/document-polling.ts        and what it stops doing

## What exists

An application is ONE `Y.Doc`, one root per table, rows nested, prose in a
container per row, kv at `!kv`. One SQLite file holds the update log and a lens
projection. The whole surface is synchronous: `db.notes.create/get/update/
delete/ids/list`, `db.notes.document(id)`, `db.kv.get/update`, `db.query`.

Sync: the client coalesces its own unsent bytes on an idle timer, chunks at the
storage boundary, and holds work as owed until the authority returns a position.
The authority keeps ONE snapshot plus the entries after it, never reads the
bytes, and has zero Yjs imports. A throwaway lab (`apps/sync-lab`) runs it on
real Cloudflare.

## The four waves, and a correction that reorders them

The spec has the detail. What matters most for how you start:

**Wave 1, the prose binding, was planned as the risky unknown and is not one.**
Honeycrisp uses ProseMirror, not CodeMirror; `@y/prosemirror` is already a
dependency; and `Editor.svelte` already takes its target as a `yxmlfragment:
Y.Type` prop handed to `configureYProsemirror({ ytype })`. The store's
`db.notes.document(id).get('editor')` returns exactly that type, and ADR-0215
already measured `@y/prosemirror` bound to a NESTED CONTAINER working. So this
is wiring. **Do not hand-roll a binding.** If you find yourself writing one,
stop and re-read ADR-0215's editor section.

**Wave 2, the subscription, is the real work.** The store has none: `list()` is
a snapshot and nothing tells a UI a row changed. Honeycrisp today calls an async
`refresh()` after every mutation, guarded by a `refreshGeneration` counter that
exists only to discard races, and POLLS each open note every second through the
old HTTP path. All of that gets deleted.

The granularity is settled and the reasoning is in the spec: per-table
invalidation carrying row ids, reusing `packages/lens/src/observation.ts`
verbatim. A first draft argued for one whole-document signal and was wrong,
because `get`/`list`/`ids` read the CRDT directly and only `db.query` reads the
projection. The row ids come from `root.on('delta')`, NOT from `observeDeep`,
which genuinely cannot name the row.

**One measured hazard dictates the implementation**: the delta event fires
synchronously inside `applyUpdateV2`, before `persist()` rebuilds the
projection. At notify time the CRDT reports the new row while `db.query` does
not. Buffer row ids during the transaction and flush AFTER `persist()` returns.

**Wave 3, the sync driver.** The client owns no socket on purpose, which is why
its timing rules are testable without a network, and that should survive. What
should not is that reconnecting on `status().needsResync` is a CORRECTNESS
requirement living in each caller's copy of the connect loop; a fuzz proved
omitting it wedges a device permanently while everything looks healthy. Host
owns construction (socket, backoff, auth), library owns correctness (cursor in
the URL, pump order, reconnect on close and on `needsResync`). Additive:
`createSyncClient` stays as it is underneath.

Consider a watchdog while you are there: if a submission goes unacknowledged
past some multiple of normal latency, reconnect. That makes the open stall below
self-healing regardless of its cause.

**Waves 4 and 5** are the migration itself and stopping `@epicenter/data`'s main
export from pointing at the superseded stack.

## What you will recognise as right

- Nothing polls.
- `refreshGeneration` and every manual `refresh()` call site are gone.
- No `await` on a read.
- Two real devices: write a note on one, see it on the other, with prose.
- `store.pressure()` surfaced somewhere visible.

## Hazards

- **Whispering and vocab still run on the OLD stack** in this same package:
  `packages/data/src/replica/`, `protocol/v1/`, `documents.ts`, `epicenter.ts`,
  `sync-supervisor.ts`. Do not modify or delete them. `@epicenter/data`'s main
  export still points there, which is Wave 5, not Wave 1.
- **`packages/data` is MIT and `packages/server` is AGPL.** Do not copy code
  between them.
- **`apps/sync-lab` is deployed and UNAUTHENTICATED** at
  `epicenter-sync-lab.epicenter.workers.dev`. Fine for a lab; delete it with
  `bun x wrangler delete --name epicenter-sync-lab` when it stops earning its
  keep. Redeploy after changing anything in `packages/data/src/sync/`, or the
  live authority drifts from the code.
- **Do not reintroduce compaction proofs, baselines, generations or a retention
  window.** ADR-0220 replaced all of it; four earlier designs died there.
- Git hygiene here: stage explicit paths, never `git add .`, no AI attribution
  in commits.

## Two open items, neither claimed fixed

- **A production stall.** A sustained run against Cloudflare stops waiting for
  an acknowledgement, seen at messages 85, 105, 461 and 529, no exception
  logged. FOUR hypotheses tested; three were real bugs and none was this
  (snapshot thrash, attachment write amplification, a woken authority left deaf,
  gradual degradation). A dedicated diagnostic drove 6,000 sends across three
  shapes with no stall and flat latency, which rules out gradual degradation:
  when it stalls it stops dead. The triggering shape is thousands of sequential
  single-row pushes with coalescing off, a stress regime rather than an
  application one. Details in `packages/data/evidence/workerd/results.md`. Do
  not spend the session on it; the Wave 3 watchdog is the cheaper answer.
- **`Y.Type.clone()` is broken for nested types in `@y/y@14.0.0-rc.24`.** Pinned
  in `packages/data/evidence/rebuild-copy.test.ts` along with a twelve-line
  recursion that works. Only matters if you need to re-mint identities.

## How this work has been going, because it should continue

Eight defects were found this week. **Every one came from running or fuzzing the
system; none came from a scenario test written from imagination.** Several
records asserted numbers that their own benchmarks then refuted, twice in
ADR-0220 alone, and each time reasoning had the direction right and the
magnitude wrong.

So: every experiment carries a CONTROL THAT MUST FAIL if the test is not live,
reported beside the result. Assert on the receiving replica's own rows, never on
a counter the harness keeps. Measurements belong in `packages/data/evidence/`,
not in a commit message, and a number in a comment needs a committed script
behind it. `packages/data/src/sync/transport.test.ts` has a seeded convergence
fuzz worth extending rather than replacing.

## Verify with

    bun test packages/data packages/lens
    bun run --cwd packages/data typecheck
    bun run --cwd apps/sync-lab typecheck
    bun run --cwd apps/sync-lab test            # hibernation, in real workerd
    bun run scripts/check-doc-hygiene.ts && bun run scripts/check-doc-paths.ts
    bun dev:honeycrisp                          # from the repo root, never cd in

and for the transport, redeploy the lab and run
`bun run packages/data/evidence/workerd/probe.ts <origin>`.

## Done looks like

Honeycrisp running on the new store with nothing polling, two real devices
syncing a note including its prose, the waves that landed recorded as ADRs and
the spent parts of the spec deleted, or a blocker list naming the smallest
remaining decisions.

Codex is available for a bounded second pass through the literal
`/codex:rescue` command: a diff to excavate, a focused verification, an
independent read of a decision. Examples, not instructions. What it returns is
evidence, not a verdict.
