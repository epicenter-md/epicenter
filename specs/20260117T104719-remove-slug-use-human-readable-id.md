# Remove Slug, Use Human-Readable ID

**Date**: 2026-01-17
**Status**: Draft

## Problem

Currently workspaces have two identity fields:

- `id` (GUID): 15-char nanoid like `abc123xyz789012`
- `slug`: kebab-case like `my-workspace`

This is redundant. The `slug` is what users actually see as "Workspace ID" in the UI, but internally we generate a separate GUID. The GUID appears in URLs (`/workspaces/abc123xyz789012`) making them unreadable.

## Solution

Eliminate `slug` entirely. Make `id` the human-readable identifier that users choose.

### ID Format Rules

1. **Validation**: `^[a-z0-9][a-z0-9.-]*$` (lowercase alphanumeric, dots, hyphens)
2. **Canonicalization**: Always stored lowercase
3. **Namespace**: Optional dot-separated prefix
   - Users can use: `my-notes`, `work.projects`, `epicenter.whispering`
   - Epicenter apps follow convention: `epicenter.{appname}`
4. **Uniqueness**: Hard error on duplicates (same ID = same Y.Doc in sync)

### Examples

| Input                  | Stored ID              | Valid?                       |
| ---------------------- | ---------------------- | ---------------------------- |
| `My Workspace`         | `my-workspace`         | Yes (auto-generated)         |
| `epicenter.whispering` | `epicenter.whispering` | Yes                          |
| `work.projects.2024`   | `work.projects.2024`   | Yes (multiple dots OK)       |
| `UPPERCASE`            | `uppercase`            | Yes (canonicalized)          |
| `-invalid`             | - | No (can't start with hyphen) |
| `has spaces`           | - | No (spaces not allowed)      |

### Where ID Is Used

All locations use the **exact same ID string** (no transformations):

| Location        | Example                                                         |
| --------------- | --------------------------------------------------------------- |
| Storage folder  | `{appLocalDataDir}/workspaces/epicenter.whispering/`            |
| URL             | `/workspaces/epicenter.whispering`                              |
| Y.Doc GUID      | `epicenter.whispering` (head), `epicenter.whispering-0` (epoch) |
| Registry        | `['epicenter.whispering', 'my-notes', ...]`                     |
| definition.json | `{ "id": "epicenter.whispering", "name": "Whispering", ... }`   |

Dots are URL-safe (`encodeURIComponent('epicenter.whispering')` = `'epicenter.whispering'`) and filesystem-safe on all platforms.

## Changes Required

### 1. Remove `slug` from Types

**packages/epicenter/src/core/workspace/workspace.ts**

```typescript
// BEFORE
export type WorkspaceDefinition = {
  id: string;
  slug: string;  // DELETE
  name: string;
  tables: ...;
  kv: ...;
};

// AFTER
export type WorkspaceDefinition = {
  id: string;
  name: string;
  tables: ...;
  kv: ...;
};
```

**packages/epicenter/src/core/capability.ts**

```typescript
// BEFORE
export type CapabilityContext = {
  id: string;
  slug: string;  // DELETE
  ...
};

// AFTER
export type CapabilityContext = {
  id: string;
  ...
};
```

### 2. Remove `slug` from Normalization

**packages/epicenter/src/core/workspace/normalize.ts**

- Remove `slug` from `WorkspaceDefinitionShape`
- Remove slug derivation logic (`const slug = idParts...`)
- Update `normalizeWorkspace()` to not return `slug`

### 3. Update CreateWorkspaceDialog

**apps/epicenter/src/lib/components/CreateWorkspaceDialog.svelte**

Current flow:

```
name → auto-generate slug → on submit: generate GUID, store both
```

New flow:

```
name → auto-generate id → on submit: store id directly
```

Changes:

- Rename internal state: `slug` → `id`
- Remove GUID generation from `createWorkspace` mutation
- Use `toKebabCase(name)` as the auto-generated `id`
- Add validation: `^[a-z0-9][a-z0-9.-]*$`
- Add uniqueness check against registry

### 4. Update workspaces.ts Query Layer

**apps/epicenter/src/lib/query/workspaces.ts**

```typescript
// BEFORE
createWorkspace: defineMutation({
  mutationFn: async (input: { name: string; slug: string }) => {
    const guid = generateGuid();
    const definition: WorkspaceDefinition = {
      id: guid,
      slug: input.slug,
      name: input.name,
      ...
    };
  }
});

// AFTER
createWorkspace: defineMutation({
  mutationFn: async (input: { name: string; id: string }) => {
    // Validate ID format
    if (!isValidWorkspaceId(input.id)) {
      return WorkspaceErr({ message: 'Invalid workspace ID format' });
    }
    // Check uniqueness
    if (registry.hasWorkspace(input.id)) {
      return WorkspaceErr({ message: `Workspace "${input.id}" already exists` });
    }

    const definition: WorkspaceDefinition = {
      id: input.id,
      name: input.name,
      tables: {},
      kv: {},
    };
    ...
  }
});
```

### 5. Update All slug References

Files with `slug` references to update:

**packages/epicenter/**

- `src/core/workspace/workspace.ts` - Type definition
- `src/core/workspace/normalize.ts` - Normalization logic
- `src/core/capability.ts` - CapabilityContext type
- `src/core/workspace/node.ts` - Node workspace types
- `src/capabilities/sqlite/sqlite.ts` - Uses `slug` for log paths
- `scripts/*.ts` - Test scripts

**apps/epicenter/**

- `src/lib/components/CreateWorkspaceDialog.svelte` - UI state
- `src/lib/query/workspaces.ts` - Mutation input
- `src/lib/components/HomeSidebar.svelte` - Calls createWorkspace
- `src/routes/(home)/+page.svelte` - Calls createWorkspace
- `src/routes/(workspace)/workspaces/[id]/+layout.ts` - Logs slug

### 6. Add ID Validation Utility

**apps/epicenter/src/lib/utils/workspace-id.ts** (new file)

```typescript
/**
 * Workspace ID validation.
 *
 * Rules:
 * - Lowercase alphanumeric, dots, hyphens only
 * - Must start with alphanumeric
 * - Examples: "my-notes", "epicenter.whispering", "work.projects.2024"
 */

const WORKSPACE_ID_REGEX = /^[a-z0-9][a-z0-9.-]*$/;

export function isValidWorkspaceId(id: string): boolean {
	return WORKSPACE_ID_REGEX.test(id);
}

export function normalizeWorkspaceId(id: string): string {
	return id.toLowerCase();
}

export function generateWorkspaceId(name: string): string {
	// Use existing toKebabCase utility
	return toKebabCase(name);
}
```

## Migration

No backwards compatibility needed. User will delete existing workspaces.

## UI Changes

The CreateWorkspaceDialog already shows "Workspace ID" for the slug field. The only changes:

1. Validation message if ID format is invalid
2. Error message if ID already exists
3. Helper text: "Used in URLs and file paths. Cannot be changed later."

## Todo

- [x] Remove `slug` from `WorkspaceDefinition` type
- [x] Remove `slug` from `CapabilityContext` type
- [x] Remove `slug` from `normalizeWorkspace()` function
- [x] Update `CreateWorkspaceDialog` to use `id` instead of `slug`
- [x] Update `createWorkspace` mutation to accept `id` instead of `slug`
- [x] Update all callers of `createWorkspace` (HomeSidebar, +page.svelte)
- [x] Update SQLite provider to use `id` instead of `slug` for log paths
- [x] Update workspace/node.ts to remove slug references
- [x] Remove `slug` references from test scripts
- [x] Update layout.ts logging to not reference slug
- [ ] LATER: Add `isValidWorkspaceId()` and `normalizeWorkspaceId()` utilities
- [ ] LATER: Add uniqueness check against registry
- [ ] Keep `@sindresorhus/slugify` - still used by toKebabCase utility and to-drizzle converter

## Review

### Changes Made (2026-01-17)

**Core Type Changes:**

1. Removed `slug` property from `WorkspaceDefinition` type in `packages/epicenter/src/core/workspace/workspace.ts`
2. Removed `slug` property from `CapabilityContext` type in `packages/epicenter/src/core/capability.ts`
3. Removed `slug` from `WorkspaceDefinitionShape` and `normalizeWorkspace()` in `packages/epicenter/src/core/workspace/normalize.ts`
4. Updated documentation and JSDoc comments throughout

**UI Changes:**

1. `CreateWorkspaceDialog.svelte`: Renamed all `slug` state/props to `id`
2. `HomeSidebar.svelte` and `+page.svelte`: Updated callback to pass `{ name, id }` instead of `{ name, slug }`
3. Updated helper text: "Used in URLs and file paths. Cannot be changed later."

**Query Layer:**

1. `workspaces.ts`:
   - `createWorkspace` mutation now accepts `{ name: string; id: string }` instead of `{ name: string; slug: string }`
   - Removed `generateGuid()` import and usage - the user-provided ID is now used directly
   - Removed `slug` from the returned `WorkspaceDefinition`

**Provider Updates:**

1. `sqlite.ts`: Changed `{ slug, tables }` destructuring to `{ id, tables }` for log path

**Test Scripts:**

1. Updated all 3 simulation scripts to use human-readable IDs instead of `generateGuid()`
2. Removed `generateGuid` imports from scripts

### What Still Works

- `toKebabCase()` utility - still used for auto-generating IDs from names
- `@sindresorhus/slugify` dependency - still used by toKebabCase and to-drizzle.ts

### Breaking Changes

- `WorkspaceDefinition` no longer has a `slug` property
- `CapabilityContext` no longer has a `slug` property
- `createWorkspace` mutation signature changed from `{ name, slug }` to `{ name, id }`
- Existing workspaces with GUID-style IDs should be deleted (no migration path)

### Deferred Work

- ID format validation (regex: `^[a-z0-9][a-z0-9.-]*$`)
- Uniqueness check against registry before creation
- Case normalization to lowercase
