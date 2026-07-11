# Handoff: implement the greenfield table read surface

Copy-paste the prompt below into a fresh session. It links the canonical spec; this file adds only what a fresh agent cannot reconstruct from it.

---

You are working in the Epicenter monorepo. The canonical spec for this task is `specs/20260612T193000-table-read-surface.md`. Read it fully before anything else, including "How to read this spec" and the four-states table.

## Context you cannot reconstruct from the spec alone

This spec is the third pass on workspace schema conformance, and it only makes sense against the two that preceded it on this same branch (`lechuguilla-talus`):

1. The first pass (`specs/20260612T182447-workspace-schema-conformance.md`) shipped, as committed waves, the write guard (a stale binary's `set()` wins LWW via the monotonic clock and clobbers newer columns on every synced device; `update()` was accidentally safe, `set()`/`bulkSet()`/`clear()` were not), the `conformance()` read method, raw-on-every-parse-error, and the Fuji repair queue. Those commits are already on the branch. Do not revert them; this spec reworks the read surface forward from them.
2. A long adversarial design session before that killed, with named invariants, an epoch/authority protocol, an in-doc schemaVersion gate, a single-schema `defineTable`+`recover()` redesign, Jazz-style drain, a library `repair()` with timestamp preservation, and a per-user Durable Object SQLite pivot. All of those stay refused; the killing invariants are in the first spec's Rejected Alternatives table and in project memory (`epicenter_schema_evolution_direction.md`). Do not relitigate them.

What changed to license this spec: the read surface was previously left alone because `@epicenter/workspace` looked like a published contract with ~26 `getAllValid()` callers. The owner has confirmed it is greenfield, no published contract, no external consumers of the read surface. That is the single fact that turns "defer the redesign" into "do the clean break." If that ever stops being true, stop and re-scope, because wave 3 deletes published-looking methods and migrates every caller in one sweep.

The non-obvious load-bearing finding, and the reason this is a full redesign rather than a rename: Fuji and most Epicenter apps run encrypted tables, and the encrypted store today silently hides undecryptable rows (`entries()` skips them, `size` subtracts them, only a bare `unreadableEntryCount` exists). That is the encrypted twin of the schema-edit silent drop this whole effort set out to kill. The four-bucket model (`rows`, `nonconforming`, `newerWriter`, `unreadable`) exists to make that fourth state visible and to make `storedCount()` reconcile (the four buckets sum to it). Wave 2 is the heaviest because of this; do not skip or shrink the `unreadable` bucket to "just a count," that is the bug.

## Your task

Implement the spec wave by wave per its Implementation Plan. Each wave is one standalone commit with the claim already written in the spec. Test-first for waves 1, 2, and 4. The waves in order: split the error taxonomy (`NewerWriter` first-class), model the `unreadable` bucket and reconcile `storedCount`, collapse the bulk reads into `scan()` and migrate every caller, extend the write guard to unreadable rows, merge the Svelte binding, document the contract.

Stop and surface, do not guess, if:
- any spec claim contradicts the code you find (the spec is reasoning-first and deliberately light on file locations; verify against the code);
- the `scan()` vs `read()` name or the `nonconforming` vs `broken` bucket name is still open when you reach wave 3 (these are flagged Open Questions; they rename every caller, so get a decision first);
- wave 2's storage change would force a wider change to the `ObservableKvStore` contract than "enumerate present-but-unreadable entries" (surface the shape before committing to it).

## Constraints

- Use bun only (`bun run`, `bun test`, `bun x`).
- No em dashes or en dashes anywhere, including comments and commit messages.
- `AGENTS.md` is canonical; treat `CLAUDE.md` files as shims.
- Stage specific files only; never `git add .`; no AI attribution in commits.
- The working tree may contain unrelated dirty files; do not touch them.
- Library code uses `wellcrafted/logger` and `wellcrafted` Result/defineErrors, never bare console or ad hoc unions. New error variants go in the existing `defineErrors` calls, consumed by exhaustive `switch (error.name)` with a `satisfies never` default.

## Skills to load

`workspace-api` (always), `yjs` (LWW + the encrypted-store boundary), `define-errors` and `error-handling` (the error taxonomy and refusal channels, waves 1 and 4), `testing` and `tdd` (waves 1, 2, 4), `encryption` (wave 2, the undecryptable-entry enumeration), `svelte` and `ui-design` and `writing-voice` (wave 5), `greenfield-clean-breaks` (wave 3, the read-surface collapse), `standalone-commits` and `git` (every commit), `spec-execution` (the wave loop), `post-implementation-review` before handing back.

## Key files

Behavior lands in `packages/workspace/src/document/table.ts` (parseRow, the read/write surface). The shared store contract that grows the unreadable-entry probe is `packages/workspace/src/document/y-keyvalue/observable-kv-store.ts`; its plaintext implementation is `y-keyvalue-lww.ts` next to it; the encrypted implementation where `unreadableEntryCount` becomes an id-yielding enumeration is `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`. The Svelte binding merged in wave 5 is `packages/svelte-utils/src/from-table.svelte.ts`. The first consumer is the Fuji repair queue at `apps/fuji/src/routes/(signed-in)/conformance/+page.svelte` and its state at `apps/fuji/src/lib/entries-state.svelte.ts`. Prior art for classification is `apps/matter/src/lib/core/conformance.ts`.
