# Action/Provider Naming Simplification

## Problem

Current naming uses "Exports" suffix unnecessarily:

| Current                 | Cleaner Name      |
| ----------------------- | ----------------- |
| `ActionExports`         | `Actions`         |
| `defineActionExports`   | `defineActions`   |
| `ProviderExports`       | `Providers`       |
| `defineProviderExports` | `defineProviders` |

The "Exports" suffix is redundant. The returned objects ARE the actions/providers.

## Solution

Remove "Exports" suffix from type and function names.

### Actions

```typescript
// Before
type ActionExports = { [key: string]: Action | ActionExports };
function defineActionExports<T extends ActionExports>(exports: T): T;

// After
type Actions = { [key: string]: Action | Actions };
function defineActions<T extends Actions>(exports: T): T;
```

### Providers

```typescript
// Before
type ProviderExports = { destroy?: () => void | Promise<void> };
function defineProviderExports<T extends ProviderExports>(exports: T): T;

// After
type Providers = { destroy?: () => void | Promise<void> };
function defineProviders<T extends Providers>(exports: T): T;
```

## Changes

- [x] Rename `ActionExports` → `Actions`
- [x] Rename `defineActionExports` → `defineActions`
- [x] Rename `ProviderExports` → `Providers`
- [x] Rename `defineProviderExports` → `defineProviders`
- [x] Update all references across codebase
- [x] Update documentation

## Note

Config key `actions` remains unchanged. It's where you define the actions factory.

### After

```typescript
type WorkspaceConfig = {
  exports: (context) => TActions;  // Factory named "exports"
};

type TActions extends Actions;  // Output named "actions"
```

## Naming Convention

| Component                | Name            | Rationale                           |
| ------------------------ | --------------- | ----------------------------------- |
| Config key               | `exports`       | Generic; what the workspace exports |
| Return type              | `Actions`       | These ARE the actions you call      |
| Factory type (if needed) | `ActionFactory` | Singular factory, plural output     |

Same pattern for indexes:

| Component    | Name                                  |
| ------------ | ------------------------------------- |
| Config key   | `exports` (or separate `indexes` key) |
| Return type  | `Indexes`                             |
| Factory type | `IndexFactory`                        |

## Changes

- [ ] Rename `ActionExports` → `Actions`
- [ ] Rename config key `actions` → `exports`
- [ ] Update all workspace definitions
- [ ] Update types: `WorkspaceConfig`, `AnyWorkspaceConfig`, etc.
- [ ] Update documentation

## Migration

This is a breaking change. All workspace definitions need updating:

```typescript
// Before
defineWorkspace({
  actions: ({ tables }) => ({
    createPost: defineMutation({ ... }),
  })
})

// After
defineWorkspace({
  exports: ({ tables }) => ({
    createPost: defineMutation({ ... }),
  })
})
```
