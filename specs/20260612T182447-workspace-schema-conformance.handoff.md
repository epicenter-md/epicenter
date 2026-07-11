# Handoff: grill or implement the workspace schema-conformance spec

Copy-paste the prompt below into a fresh session. It links the canonical spec; this file adds only what a fresh agent cannot reconstruct from it.

---

You are working in the Epicenter monorepo. The canonical spec for this task is `specs/20260612T182447-workspace-schema-conformance.md`. Read it fully before anything else, including the "How to read this spec" block and the Rejected Alternatives table.

## Context you cannot reconstruct from the spec alone

This spec is the residue of a long adversarial design session (2026-06-12) that started from "is table-local `_v` enough, or do we need a workspace-level migration/authority protocol?" The session explored and KILLED, in order: an epoch/device-registry authority protocol, an in-doc schemaVersion write gate, a single-schema `defineTable` + `recover()` redesign, Jazz-style write-back-on-read (drain), a library `repair()` API with timestamp preservation, and a per-user Durable Object SQLite pivot. Each refusal is recorded with its killing invariant in the spec's Rejected Alternatives table and in Claude project memory (`epicenter_schema_evolution_direction.md`). A fresh-context subagent already ran a full adversarial review of the single-schema redesign and blocked it; the write guard (wave 1) and the `count()` desync finding came out of that review. Jazz was grounded via DeepWiki (garden-co/jazz): same strategy as Epicenter's `_v` with worse hygiene and no queue.

Do not relitigate the refusals without new facts. The genuinely open surface is the spec's Open Questions section (failure channel shape, clear()/delete() guarding, workspace-level aggregation, Whispering adoption timing) plus anything the spec's claims get wrong about the current code.

## Your task

MODE A (grill): stress-test the spec before implementation. Worthwhile angles that were NOT fully exercised in the prior session:
- Verify the guard's O(1) claim and its interaction with `pending`/`pendingDeletes` in `YKeyValueLww` (the in-memory map is observer-written; a `set` inside a transaction reads `pending` first; confirm the guard reads the same view the replace will act on).
- The `Result<void, ...>` return on `set()`: check real call sites across apps for places that would now silently discard a refusal they should surface.
- Encrypted stores: the guard must read stored `_v` through `createEncryptedYkvLww`; confirm decrypted values are available synchronously at guard time.
- bulkSet refusal reporting shape vs the existing chunked `onProgress` contract.
- Whether `conformance()` belongs on `ReadonlyTable` (materializers and daemon projections read but cannot repair; do they need the queue?).
Deliver findings in the fresh-eyes-grill output shape; update the spec inline where a finding changes it (it is a Draft; edit it directly).

MODE B (implement): execute the spec wave by wave per its Implementation Plan. Each wave is one standalone commit with the claim already written in the spec. Test-first for waves 1 and 2. Stop and surface if any spec claim contradicts the code you find.

## Constraints

- Use bun only (`bun run`, `bun test`, `bun x`).
- No em dashes or en dashes anywhere, including comments and commit messages.
- `AGENTS.md` is canonical; treat `CLAUDE.md` files as shims.
- Stage specific files only; never `git add .`; no AI attribution in commits.
- The working tree may contain unrelated dirty files; do not touch them.
- Library code uses `wellcrafted/logger` and `wellcrafted` Result/defineErrors, never bare console or ad hoc unions.

## Skills to load

`workspace-api` (always), `yjs` (guard + LWW semantics), `define-errors` and `error-handling` (wave 1 failure channel), `testing` and `tdd` (waves 1-2), `svelte` and `ui-design` and `writing-voice` (wave 3), `standalone-commits` and `git` (every commit), `fresh-eyes-grill` (MODE A), `spec-execution` (MODE B), `post-implementation-review` before handing back.

## Key files

Everything behavioral lands in `packages/workspace/src/document/table.ts`; the LWW substrate is `packages/workspace/src/document/y-keyvalue/y-keyvalue-lww.ts`; encrypted wrapper is `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`; svelte helper is the `fromTable` module in `packages/svelte`; prior art for classification is `apps/matter/src/lib/core/conformance.ts`.
