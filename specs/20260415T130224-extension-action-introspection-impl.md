# Extension Action Introspection: Implementation Plan

**Date**: 2026-04-15
**Spec**: `specs/20260415T130224-extension-action-introspection.md`
**Handoff**: `specs/20260415T130224-extension-action-introspection-handoff.md`

## Summary

Five changes across `packages/workspace` and `packages/cli` to make extension actions discoverable by the CLI. The core idea: stamp `defineQuery`/`defineMutation` with a symbol brand, rewrite the SQLite materializer to export actions instead of plain methods, and teach `describeWorkspace` + `epicenter run` to walk `client.extensions`.

## Todo List

### Phase 1: Action Brand Symbol

- [ ] **1.1** Add `ACTION_BRAND = Symbol.for('epicenter.action')` to `packages/workspace/src/shared/actions.ts`, export it
- [ ] **1.2** Stamp `[ACTION_BRAND]: true` in both `defineQuery` and `defineMutation` factory functions
- [ ] **1.3** Update `isAction()` to check `ACTION_BRAND in value` instead of structural `.type` check
- [ ] **1.4** Add `[ACTION_BRAND]: true` to the `ActionMeta` type
- [ ] **1.5** Export `ACTION_BRAND` from barrel files (`src/index.ts`, `src/workspace/index.ts`)
- [ ] **1.6** Run tests: `bun test packages/workspace/src/shared/` and `bun test packages/workspace/src/workspace/describe-workspace.test.ts`

### Phase 2: Widen MirrorDatabase Types

- [ ] **2.1** In `types.ts`: widen `MirrorStatement.all()` return to `MaybePromise<unknown[]>`, `get()` to `MaybePromise<unknown>`, `prepare()` to `MaybePromise<MirrorStatement>`
- [ ] **2.2** In `sqlite.ts`: `await` all `db.prepare(...)` calls (since `prepare` now returns `MaybePromise`)
- [ ] **2.3** In `sqlite.ts`: cast row results where needed (`as Record<string, unknown>`)
- [ ] **2.4** Run tests: `bun test packages/workspace/src/extensions/materializer/sqlite/`

### Phase 3: Materializer Returns defineQuery/defineMutation

- [ ] **3.1** Import `defineQuery`, `defineMutation` and `Type` from typebox into `sqlite.ts`
- [ ] **3.2** Replace `search`, `count`, `rebuild` plain methods with `defineQuery`/`defineMutation` wrappers using generic table-union inputs
- [ ] **3.3** Update `MaterializerBuilder` type to reflect new API shape
- [ ] **3.4** Update tests to call new API shape: `materializer.search({ table: 'posts', query: '...' })` instead of `materializer.search('posts', '...')`
- [ ] **3.5** Verify `isAction(materializer.search)` returns true in tests
- [ ] **3.6** Run tests: `bun test packages/workspace/src/extensions/materializer/sqlite/`

### Phase 4: CLI Extension Introspection

- [ ] **4.1** Add `extensions: Record<string, ActionDescriptor[]>` to `WorkspaceDescriptor` type in `describe-workspace.ts`
- [ ] **4.2** Update `describeWorkspace()` to walk `client.extensions` with `iterateActions`
- [ ] **4.3** Add test for new `extensions` field in `describe-workspace.test.ts`
- [ ] **4.4** Update `epicenter run` in `run.ts` to fall through to `client.extensions` when action not found in `client.actions`
- [ ] **4.5** Run tests: `bun test packages/workspace/src/workspace/describe-workspace.test.ts`

### Phase 5: Final Verification

- [ ] **5.1** Run full workspace test suite: `bun test packages/workspace`
- [ ] **5.2** Run typecheck: `bun run typecheck`

## Review

_(To be filled after implementation)_
