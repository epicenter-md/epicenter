# Non-Terminal `.withActions()`

**Date**: 2026-03-30
**Status**: Implemented
**Author**: AI-assisted

## Overview

Make `.withActions()` on `WorkspaceClientBuilder` non-terminal so it can be called before `.withExtension()`. Actions that don't depend on extensions can be declared early in the builder chain, enabling packages like `@epicenter/skills` to export a definition + actions factory as a clean two-import pattern.

## Motivation

### Current State

`.withActions()` is terminal. It returns `WorkspaceClientWithActions` with no builder methods:

```typescript
// create-workspace.ts
withActions<TActions extends Actions>(
    factory: (client: WorkspaceClient<...>) => TActions,
) {
    const actions = factory(client);
    return { ...client, actions } as unknown as WorkspaceClientWithActions<...>;
},
```

This forces actions to come LAST in the chain:

```typescript
const ws = createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)
    .withExtension('sync', createSyncExtension({ ... }))
    .withActions(({ tables }) => ({           // ← must be last
        tabs: { close: defineMutation({...}) },
    }));
```

This creates a problem:

1. **Package authors can't bundle definition + actions**: `@epicenter/skills` exports tables + standalone functions. Consumers must manually wire `importFromDisk(dir, ws)` instead of calling `ws.actions.importFromDisk(...)`. The skills actions only need `tables` and `documents`: they don't depend on extensions. But they can't be declared before extensions because `.withActions()` is terminal.

### Desired State

```typescript
import { skillsDefinition, skillsActions } from '@epicenter/skills';

const ws = createWorkspace(skillsDefinition)
    .withActions(skillsActions)          // ← before extensions, non-terminal
    .withExtension('persistence', ...)
    .withExtension('sync', ...);

await ws.actions.importFromDisk({ dir: '.agents/skills' });
```

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Non-terminal vs definition-level | Non-terminal `.withActions()` | Smaller change, doesn't pollute pure-data `WorkspaceDefinition` with functions, solves the ordering problem directly |
| Action merging strategy | Shallow spread (`{ ...existing, ...new }`) | Matches how extension accumulation works. Deep merge adds complexity for no real use case |
| `TActions` default type | `undefined` | Distinguishes "no actions declared" from "empty actions object". Conditional intersection `(TActions extends Actions ? { actions: TActions } : unknown)` keeps the `actions` property off the type when unused |
| Builder method forwarding | All builder methods thread `actions` through `buildClient()` | Same immutable-state pattern used for extensions, encryption |
| `WorkspaceClientWithActions` fate | Keep as type alias for backward compat | Alias to `WorkspaceClientBuilder<..., TActions>`. Existing explicit annotations still work |

## Architecture

### Builder Chain: Before and After

```
BEFORE (terminal):
  createWorkspace(def) → Builder<Ext={}>
    .withExtension('a', f) → Builder<Ext={a}>
    .withActions(f) → ClientWithActions  ← DEAD END

AFTER (non-terminal):
  createWorkspace(def) → Builder<Ext={}, Actions=undefined>
    .withActions(f1) → Builder<Ext={}, Actions=A1>
    .withExtension('a', f) → Builder<Ext={a}, Actions=A1>
    .withActions(f2) → Builder<Ext={a}, Actions=A1 & A2>
```

### `buildClient()` Data Flow

```
buildClient(extensions, state, encryptionRuntime?, actions?)
    │
    ├── constructs `client` object (tables, kv, documents, ydoc, ...)
    │   └── if actions !== undefined: spread { actions } onto client
    │
    ├── applyWorkspaceExtension(key, factory)
    │   └── calls buildClient(newExtensions, newState, encryption, actions)
    │                                                               ↑ forwarded
    │
    ├── withDocumentExtension(key, factory)
    │   └── calls buildClient(extensions, state, encryption, actions)
    │                                                         ↑ forwarded
    │
    ├── withEncryption(config)
    │   └── calls buildClient(extensions, state, newEncryption, actions)
    │                                                           ↑ forwarded
    │
    └── withActions(factory)  ← CHANGED
        ├── newActions = factory(client)
        ├── merged = actions ? { ...actions, ...newActions } : newActions
        └── calls buildClient(extensions, state, encryption, merged)
```

## Implementation Plan

### Phase 1: Type changes in `types.ts`

- [ ] **1.1** Add `TActions extends Actions | undefined = undefined` as 8th generic parameter to `WorkspaceClientBuilder`
- [ ] **1.2** Add conditional intersection `& (TActions extends Actions ? { actions: TActions } : unknown)` to `WorkspaceClientBuilder` body
- [ ] **1.3** Update all builder method return types to carry `TActions` forward:
  - `withExtension` → `WorkspaceClientBuilder<..., TActions>`
  - `withWorkspaceExtension` → `WorkspaceClientBuilder<..., TActions>`
  - `withDocumentExtension` → `WorkspaceClientBuilder<..., TActions>`
  - `withEncryption` → `WorkspaceClientBuilder<..., TActions>`
- [ ] **1.4** Change `withActions` return type from `WorkspaceClientWithActions` to `WorkspaceClientBuilder<..., TActions extends Actions ? TActions & TNewActions : TNewActions>`
- [ ] **1.5** Redefine `WorkspaceClientWithActions` as a type alias: `WorkspaceClientBuilder<TId, TTables, TKv, TAwareness, TExtensions, TDocExtensions, TEncryption, TActions>`

### Phase 2: Runtime changes in `create-workspace.ts`

- [ ] **2.1** Add `actions?: Actions` parameter to `buildClient()`
- [ ] **2.2** Spread actions onto the `client` object: `...(actions !== undefined ? { actions } : {})`
- [ ] **2.3** Forward `actions` in `applyWorkspaceExtension()` → its `buildClient()` call
- [ ] **2.4** Forward `actions` in `withDocumentExtension()` → its `buildClient()` call
- [ ] **2.5** Forward `actions` in `withEncryption()` → its `buildClient()` call (both the return and the error path)
- [ ] **2.6** Change `withActions()` to merge and call `buildClient()` instead of spreading and returning terminal type

### Phase 3: Tests

- [ ] **3.1** Add test: `.withActions()` before `.withExtension()`: actions available on final builder
- [ ] **3.2** Add test: multiple `.withActions()` calls merge action trees
- [ ] **3.3** Add test: `.withActions()` factory receives client WITHOUT extensions when called before extensions
- [ ] **3.4** Add test: `.withActions()` factory receives client WITH extensions when called after extensions
- [ ] **3.5** Verify existing tests still pass (no regression)

### Phase 4: Update `@epicenter/skills` to export an actions factory

- [ ] **4.1** Create `packages/skills/src/actions.ts`: exports `skillsActions` factory that wraps `importFromDisk`/`exportToDisk` as `defineMutation` actions
- [ ] **4.2** Export `skillsActions` from `packages/skills/src/index.ts`
- [ ] **4.3** Create `packages/skills/src/workspace.ts`: exports `skillsDefinition` via `defineWorkspace()`
- [ ] **4.4** Export `skillsDefinition` from `packages/skills/src/index.ts`

## Edge Cases

### Multiple `.withActions()` with overlapping keys

1. First call: `.withActions(() => ({ skills: { import: ... } }))`
2. Second call: `.withActions(() => ({ skills: { export: ... } }))`
3. Shallow spread means second `skills` namespace OVERWRITES the first. This matches JavaScript semantics. Not a bug, but worth noting. Consumers who need deep merging should use a single `.withActions()` call.

### `.withActions()` factory accessing `client.extensions` before extensions exist

1. Call `.withActions(client => { client.extensions.persistence... })` before `.withExtension('persistence', ...)`
2. `client.extensions` is `{}` at this point: accessing `.persistence` is `undefined`
3. TypeScript catches this: `TExtensions = Record<string, never>` means no properties are accessible. Runtime is safe.

### Existing tab-manager code using terminal `.withActions()`

1. Tab manager calls `.withActions()` last in the chain
2. The return type changes from `WorkspaceClientWithActions` to `WorkspaceClientBuilder` (with TActions set)
3. `WorkspaceClientBuilder` is a superset: all properties from `WorkspaceClientWithActions` still exist, plus builder methods
4. No breakage unless the type is explicitly annotated as `WorkspaceClientWithActions`

## Success Criteria

- [ ] `.withActions()` can be called before `.withExtension()` in the builder chain
- [ ] `.withActions()` can be called multiple times, merging action trees
- [ ] Actions declared before extensions correctly access `tables` and `documents`
- [ ] Actions declared after extensions correctly access `extensions`
- [ ] All existing tests pass without modification
- [ ] `@epicenter/skills` exports `skillsDefinition` and `skillsActions`
- [ ] TypeScript compilation clean (no new errors)

## References

- `packages/workspace/src/workspace/types.ts`: `WorkspaceClientBuilder`, `WorkspaceClientWithActions`, `WorkspaceClient`
- `packages/workspace/src/workspace/create-workspace.ts`: `buildClient()`, `withActions()`, `applyWorkspaceExtension()`
- `packages/workspace/src/shared/actions.ts`: `Actions` type, `defineQuery`, `defineMutation`
- `packages/workspace/src/workspace/create-workspace.test.ts`: existing tests
- `packages/skills/src/disk.ts`: `importFromDisk`, `exportToDisk`, `SkillsWorkspaceClient`
- `packages/skills/src/index.ts`: current exports

## Review

### Changes Made

**`packages/workspace/src/workspace/types.ts`**
- Added `TActions extends Actions | undefined = undefined` as 8th generic parameter to `WorkspaceClientBuilder`
- Added conditional intersection `(TActions extends Actions ? { actions: TActions } : unknown)` so `actions` only appears on the type when declared
- Updated all builder method return types (`withExtension`, `withWorkspaceExtension`, `withDocumentExtension`, `withEncryption`) to carry `TActions` forward
- Changed `withActions` from terminal (returning `WorkspaceClientWithActions`) to non-terminal (returning `WorkspaceClientBuilder` with merged `TActions`)
- Redefined `WorkspaceClientWithActions` as a type alias for `WorkspaceClientBuilder<..., TActions>` for backward compatibility

**`packages/workspace/src/workspace/create-workspace.ts`**
- Added optional `actions?: Actions` parameter to `buildClient()`
- Spread `actions` onto the `client` object when present
- Forwarded `actions` through all builder methods (`applyWorkspaceExtension`, `withDocumentExtension`, `withEncryption`)
- Changed `withActions()` from terminal spread to merge-and-rebuild: `{ ...existingActions, ...newActions }`
- Removed unused `WorkspaceClientWithActions` import

**`packages/workspace/src/workspace/create-workspace.test.ts`**
- Added 5 new tests covering: actions before extensions, multiple merging calls, extension visibility at factory time, actions closing over live tables, and continued chaining after `withActions()`

**`packages/skills/src/workspace.ts`** (new)
- Exports `skillsDefinition`: a `defineWorkspace()` result with `id: 'epicenter.skills'`

**`packages/skills/src/actions.ts`** (new)
- Exports `skillsActions` factory wrapping `importFromDisk`/`exportToDisk` as `defineMutation` actions

**`packages/skills/src/index.ts`**
- Added exports for `skillsDefinition` and `skillsActions`
- Updated module JSDoc example to show the new pattern

### Verification

- **Typecheck**: Clean on all modified files (56 pre-existing errors in unrelated files unchanged)
- **Tests**: 55/55 pass, 0 failures. 5 new tests added, all existing tests unaffected
- **Backward compat**: `WorkspaceClientWithActions` preserved as type alias. Existing `.withActions()` call sites get a builder (superset of previous terminal type)
