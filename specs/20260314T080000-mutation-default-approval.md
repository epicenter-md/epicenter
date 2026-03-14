# Mutation-Default Approval

**Date**: 2026-03-14
**Status**: Complete
**Author**: AI-assisted

---

## Overview

Remove the per-action `destructive` flag and make all mutations require approval by default. Queries never need approval. The existing `toolTrust` table with [Always Allow] already handles approval fatigue.

---

## Motivation

### Current State

Three commits on March 12, 2026 built the approval system in stages.

`4b76002ae` added `title` and `destructive` to `ActionConfig`. The tool bridge had two approval mechanisms: per-action `destructive: true → needsApproval: true`, and a blanket `requireApprovalForMutations` option.

`01d13cf30` added the `toolTrust` table—a Y.Doc-backed store for per-tool trust preferences (`'ask'` or `'always'`), synced across devices via CRDT.

`5d5127e73` removed `requireApprovalForMutations` entirely. After that refactor, `needsApproval` is only set when `destructive: true`.

Today, `ActionConfig` and `ActionMeta` carry this field:

```typescript
type ActionConfig<TInput, TOutput> = {
  title?: string;
  description?: string;
  /** Whether this action is destructive. Maps to `needsApproval` in the tool bridge. */
  destructive?: boolean;
  input?: TInput;
  handler: ActionHandler<TInput, TOutput>;
};
```

And the tool bridge maps it like this:

```typescript
// packages/ai/src/tool-bridge.ts, line 143
...(action.destructive && { needsApproval: true }),
```

`ActionDescriptor` in `describe-workspace.ts` also carries the field and forwards it:

```typescript
export type ActionDescriptor = {
  path: string[];
  type: 'query' | 'mutation';
  title?: string;
  description?: string;
  destructive?: boolean;  // ← forwarded from ActionMeta
  input?: TSchema;
};
```

### Problems

The `destructive` flag has one dangerous failure mode: the developer must remember to set it. Forget it, and a mutation auto-executes with zero friction.

Out of 13 tab-manager actions (5 queries, 8 mutations), only `tabs.close` has `destructive: true`. The other 7 mutations—`tabs.open`, `tabs.activate`, `tabs.pin`, `tabs.unpin`, `tabs.move`, `tabs.group`, `tabs.save`—auto-execute with no approval dialog. That's not a deliberate choice; it's an omission.

The flag also creates a conceptual mismatch. "Destructive" is a judgment call. `tabs.save` with `close: true` is destructive. `tabs.open` with 50 URLs is destructive. The developer has to anticipate every dangerous combination at definition time, which is impossible.

### Desired State

Mutations need approval by default. Queries never do. The tool bridge becomes:

```typescript
...(action.type === 'mutation' && { needsApproval: true }),
```

`destructive` disappears from `ActionConfig`, `ActionMeta`, `ActionDescriptor`, and every call site. The `toolTrust` table already handles the approval fatigue problem: users click [Always Allow] once per mutation and never see the dialog again. That preference syncs across devices via CRDT.

---

## Research Findings

### How Other Systems Handle Default Trust

| System | Default for writes | Opt-out mechanism |
|---|---|---|
| macOS Gatekeeper | Prompt on first run | User grants permanent permission |
| iOS permissions | Deny until granted | Per-app, per-capability grant |
| Chrome extension APIs | Prompt per dangerous API | Manifest declares permissions |
| sudo | Prompt every time (or cached) | `NOPASSWD` in sudoers |
| This codebase (before) | Auto-execute unless `destructive: true` | No opt-out for safe mutations |
| This codebase (after) | Prompt for all mutations | [Always Allow] per tool |

The pattern across all of these: safe default is "ask", not "allow". The escape hatch is a persistent grant, not a per-action flag.

### The `toolTrust` Table

The `toolTrust` table was built specifically to solve approval fatigue. It stores `{ id: toolName, trust: 'ask' | 'always' }` in a Y.Doc, synced across devices. When a user clicks [Always Allow], the tool moves from `'ask'` to `'always'` and never prompts again.

This means the approval-fatigue argument against mutation-default approval is already solved. The infrastructure exists. The only missing piece is flipping the default.

### Current Tab-Manager Mutation Coverage

| Action | Has `destructive: true`? | Should need approval? |
|---|---|---|
| `tabs.close` | Yes | Yes |
| `tabs.open` | No | Yes |
| `tabs.activate` | No | Yes |
| `tabs.pin` | No | Yes |
| `tabs.unpin` | No | Yes |
| `tabs.move` | No | Yes |
| `tabs.group` | No | Yes |
| `tabs.save` | No | Yes |

Seven of eight mutations currently auto-execute. After this change, all eight require approval on first use.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Default for mutations | `needsApproval: true` always | Safe default; developer omission can't silently bypass approval |
| Default for queries | `needsApproval` omitted | Queries are declared read-only; no state change, no approval needed |
| Remove `destructive` flag | Yes, entirely | Redundant once mutations default to approval; removing it prevents confusion |
| Migration for existing `toolTrust` entries | None needed | Existing `'always'` entries continue to work; the table is keyed by tool name |
| New types or options | None | Pure simplification; no new concepts introduced |
| `tabs.close` `destructive: true` | Remove it | The flag is gone; `tabs.close` gets approval because it's a mutation |

---

## Architecture

### Before: Approval Gated on `destructive` Flag

```
ActionConfig
  ├── title?: string
  ├── description?: string
  ├── destructive?: boolean   ← developer must remember to set this
  ├── input?: TSchema
  └── handler: ActionHandler

actionsToClientTools()
  └── for each action:
        if action.destructive → needsApproval: true
        else                  → (omitted, auto-executes)

Result:
  tabs.close  → needsApproval: true   ✓
  tabs.open   → (omitted)             ✗ auto-executes
  tabs.pin    → (omitted)             ✗ auto-executes
  tabs.save   → (omitted)             ✗ auto-executes
  ... (5 more mutations auto-execute)
```

### After: Approval Gated on Action Type

```
ActionConfig
  ├── title?: string
  ├── description?: string
  ├── input?: TSchema
  └── handler: ActionHandler

actionsToClientTools()
  └── for each action:
        if action.type === 'mutation' → needsApproval: true
        if action.type === 'query'   → (omitted, auto-executes)

Result:
  tabs.close    → needsApproval: true   ✓
  tabs.open     → needsApproval: true   ✓
  tabs.pin      → needsApproval: true   ✓
  tabs.save     → needsApproval: true   ✓
  tabs.search   → (omitted)             ✓ query, read-only
  tabs.getAll   → (omitted)             ✓ query, read-only
```

### Trust Escalation Flow (unchanged)

```
User sends message → AI calls mutation tool
                           │
                           ▼
              toolTrust.get(toolName) === 'always'?
                    │                    │
                   Yes                  No
                    │                    │
                    ▼                    ▼
             auto-approve         show approval UI
                                  [Allow] [Always Allow] [Deny]
                                         │
                                  [Always Allow] clicked
                                         │
                                         ▼
                                  toolTrust.set(toolName, 'always')
                                  (syncs to all devices via CRDT)
                                         │
                                         ▼
                                  future calls auto-approve
```

---

## Implementation Plan

### Phase 1: Core types — remove `destructive` from `ActionConfig` and `ActionMeta`

- [x] **1.1** In `packages/workspace/src/shared/actions.ts`, remove `destructive?: boolean` from `ActionConfig` (line ~133) and its JSDoc comment (line ~132)
- [x] **1.2** In the same file, remove `destructive?: boolean` from `ActionMeta` (line ~151) and its JSDoc comment (line ~150)

### Phase 2: Tool bridge — flip the approval condition

- [x] **2.1** In `packages/ai/src/tool-bridge.ts` line 143, change:
  ```typescript
  ...(action.destructive && { needsApproval: true }),
  ```
  to:
  ```typescript
  ...(action.type === 'mutation' && { needsApproval: true }),
  ```
- [x] **2.2** Update the JSDoc for `needsApproval` in `ToolDefinitionPayload` (lines 84–88). Change "Only present when the action is marked `destructive`" to "Present on all mutations. Queries never need approval."
- [x] **2.3** Update the JSDoc for `actionsToClientTools` to reflect the new behavior

### Phase 3: Tool bridge tests — update for mutation-default semantics

- [x] **3.1** Rename test `'destructive action sets needsApproval without blanket option'` to `'all mutations get needsApproval'`
- [x] **3.2** Update that test: the `open` mutation (currently expected to have `needsApproval` undefined) should now have `needsApproval: true`. Remove `destructive: true` from the `close` action definition.
- [x] **3.3** Rename test `'non-destructive tools omit needsApproval entirely'` to `'queries omit needsApproval entirely'`
- [x] **3.4** Update that test: the `mutation` action should now have `needsApproval: true`, not undefined. Only the `query` action should omit it.
- [x] **3.5** Rename test `'only forwards needsApproval for destructive tools'` to `'forwards needsApproval for all mutations, not queries'`
- [x] **3.6** Update that test: the `destructive` mutation (renamed to something like `save`) should have `needsApproval: true` without `destructive: true` in its definition. The `safe` query should still omit it. Remove all `destructive: true` from test action definitions.

### Phase 4: `ActionDescriptor` — remove `destructive` from workspace descriptor

- [x] **4.1** In `packages/workspace/src/workspace/describe-workspace.ts`, remove `destructive?: boolean` from `ActionDescriptor` (line ~48)
- [x] **4.2** In the same file, remove the conditional spread `...(action.destructive !== undefined && { destructive: action.destructive })` from `describeWorkspace` (lines ~128–130)

### Phase 5: Descriptor tests — update for removed field

- [x] **5.1** In `packages/workspace/src/workspace/describe-workspace.test.ts`, rename test `'title and destructive appear in action descriptors'` to `'title appears in action descriptors'`
- [x] **5.2** Remove `destructive: true` from the `delete` mutation definition in that test (line ~236)
- [x] **5.3** Remove the assertion `expect(deleteAction?.destructive).toBe(true)` (line ~261)
- [x] **5.4** Remove the assertion `expect(getAllAction?.destructive).toBeUndefined()` (line ~255)
- [x] **5.5** Remove the assertion `expect(createAction?.destructive).toBeUndefined()` (line ~267)

### Phase 6: Tab-manager workspace — remove the last `destructive: true` call site

- [x] **6.1** In `apps/tab-manager/src/lib/workspace.ts` line 674, remove `destructive: true,` from the `tabs.close` action definition
- [x] **6.2** *(discovered during implementation)* Remove `destructive: true,` from `tabs.dedup` action definition (line ~887), added in `6096e7d` after the spec was written

### Phase 7: JSDoc updates — replace "destructive" language with "mutation"

- [x] **7.1** In `apps/tab-manager/src/lib/state/tool-trust.svelte.ts` line 4, change "Destructive AI tools start as 'ask'" to "Mutation tools start as 'ask'"
- [x] **7.2** In the same file line 9, change "Non-destructive tools never consult this module" to "Query tools never consult this module"
- [x] **7.3** In the same file line 54, change "Non-destructive tools should not call this" to "Query tools should not call this"
- [x] **7.4** In the same file line 18, change "Trust level for a destructive tool" to "Trust level for a mutation tool"
- [x] **7.5** In `apps/tab-manager/src/lib/ai/system-prompt.ts` line 28, change "Destructive actions (like closing tabs) have their own approval UI — do not ask for confirmation in prose" to "Mutations (actions that change state) have their own approval UI — do not ask for confirmation in prose"
- [x] **7.6** In `apps/tab-manager/src/lib/state/chat-state.svelte.ts` line 462, change "on a destructive tool call in the chat" to "on a mutation tool call in the chat"

### Phase 8: Verification

- [x] **8.1** Run `bun test` in `packages/ai` — all tests pass (4/4)
- [x] **8.2** Run `bun test` in `packages/workspace` — all tests pass (347/347)
- [x] **8.3** Run `bun run typecheck` from the repo root — no new errors (pre-existing `NumberKeysOf`/`Uint8Array` issues unrelated)
- [x] **8.4** Search the codebase for `destructive:` (with colon) to confirm no remaining usage in action definitions. 4 matches are all `variant="destructive"` in shadcn-svelte UI components (unrelated Tailwind styling).

---

## Edge Cases

### `tabs.save` with `close: true`

`tabs.save` accepts a `close` argument. When `close: true`, it closes the tab after saving—making it conditionally destructive. This was one argument for per-action `destructive` flags: you could mark only the dangerous variant.

With mutation-default approval, `tabs.save` always requires approval regardless of arguments. This is the correct behavior. The approval UI shows the full argument object, including `close: true`, so the user sees exactly what will happen before approving. The user can deny if they only wanted to save without closing.

### New mutations added by developers

Any new `defineMutation` call automatically gets `needsApproval: true` in the tool bridge. The developer doesn't have to remember anything. The old system required an explicit `destructive: true`; the new system is safe by default.

### Queries with side effects

If a developer puts side effects inside a `defineQuery` handler, those effects won't trigger approval. This is intentional. Queries are declared read-only by contract. If a query has side effects, that's a bug in the action definition, not a gap in the approval system.

### Existing `toolTrust` entries

Users who already clicked [Always Allow] on `tabs_close` have a `{ id: 'tabs_close', trust: 'always' }` row in their `toolTrust` table. That row continues to work after this change. No migration needed. The table is keyed by tool name, and tool names don't change.

### First-time approval fatigue

On first use after this change, users will see approval dialogs for mutations they previously didn't see them for: `tabs.open`, `tabs.activate`, `tabs.pin`, etc. Each one requires one click of [Always Allow] to dismiss permanently. That preference syncs to all their devices via CRDT. The fatigue is bounded and one-time.

---

## Open Questions

1. **Should `tabs.search` and other read-heavy queries ever need approval?**
   - These are pure reads with no state change. The current design never prompts for queries.
   - Recommendation: No. Queries are declared read-only. If a query is doing something surprising, fix the query.

2. **Should the `toolTrust` table be pre-populated with `'always'` for obviously safe mutations?**
   - Options: (a) ship with empty table, users grant trust on first use; (b) pre-populate `tabs.open`, `tabs.activate`, `tabs.pin` as `'always'` in the workspace seed data.
   - Recommendation: Ship with empty table. Pre-populating trust defeats the purpose of the approval system. Users should consciously grant trust, even for safe-seeming mutations. The one-time cost is low.

3. **Does `ActionDescriptor` need a replacement field to communicate mutation semantics to MCP consumers?**
   - `ActionDescriptor` already has `type: 'query' | 'mutation'`. MCP consumers can infer approval semantics from `type`.
   - Recommendation: No new field needed. `type` is sufficient.

---

## Success Criteria

- [x] `ActionConfig` has no `destructive` field
- [x] `ActionMeta` has no `destructive` field
- [x] `ActionDescriptor` has no `destructive` field
- [x] `actionsToClientTools` sets `needsApproval: true` for every mutation
- [x] `actionsToClientTools` omits `needsApproval` for every query
- [x] No `destructive:` property in any action definition across the codebase (grep confirms)
- [x] `bun test` passes in `packages/ai`
- [x] `bun test` passes in `packages/workspace`
- [x] `bun run typecheck` passes with no new errors
- [x] No `as any` or `@ts-ignore` introduced

---

## References

- `packages/workspace/src/shared/actions.ts` — `ActionConfig`, `ActionMeta` types with `destructive` field
- `packages/ai/src/tool-bridge.ts` — `actionsToClientTools`, `toToolDefinitions`, `needsApproval` logic
- `packages/ai/src/tool-bridge.test.ts` — tool bridge tests with `destructive`-based assertions
- `packages/workspace/src/workspace/describe-workspace.ts` — `ActionDescriptor`, `describeWorkspace` with `destructive` spread
- `packages/workspace/src/workspace/describe-workspace.test.ts` — descriptor tests asserting `destructive` field
- `apps/tab-manager/src/lib/workspace.ts` — only remaining `destructive: true` call site (`tabs.close`)
- `apps/tab-manager/src/lib/state/tool-trust.svelte.ts` — trust state module with "destructive" language in JSDoc
- `apps/tab-manager/src/lib/ai/system-prompt.ts` — system prompt mentioning "destructive actions"
- `apps/tab-manager/src/lib/state/chat-state.svelte.ts` — chat state JSDoc mentioning "destructive tool call"
- `specs/20260312T153000-action-metadata-title-destructive.md` — original spec for the `destructive` flag
- `specs/20260312T170000-progressive-tool-trust.md` — progressive trust spec documenting the `toolTrust` table

---

## Review

### Summary

Pure simplification: removed the per-action `destructive` flag and made all mutations require approval by default. 8 commits across 9 files, ~30 lines changed (mostly deletions).

### Deviation from spec

The spec listed `tabs.close` as the only `destructive: true` call site. During implementation, a second call site was discovered on `tabs.dedup` (added in commit `6096e7d` after the spec was written). Both were removed.

### Verification results

- `bun test` in `packages/ai`: 4/4 pass
- `bun test` in `packages/workspace`: 347/347 pass
- `bun run typecheck`: no new errors (pre-existing `NumberKeysOf`/`Uint8Array` issues unrelated)
- `destructive:` grep: zero action-definition matches; 4 hits are `variant="destructive"` in shadcn-svelte UI components (unrelated Tailwind styling)
- No `as any` or `@ts-ignore` introduced
