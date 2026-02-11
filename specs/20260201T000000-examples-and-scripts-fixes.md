# Specification: Fix Type Errors in Examples and Scripts

**Status**: ~~Draft~~ → **COMPLETED**
**Created**: 2026-02-01
**Completed**: 2026-02-01
**Scope**: `examples/` folder and `packages/epicenter/scripts/`

## Execution Summary

The examples and scripts used a completely non-existent API pattern. Rather than rewriting everything, the broken code was deleted.

### Deleted
- `examples/basic-workspace/` - Entire directory
- `examples/content-hub/` - Entire directory
- `examples/stress-test/` - Entire directory
- `packages/epicenter/scripts/email-storage-simulation.ts`
- `packages/epicenter/scripts/email-minimal-simulation.ts`
- `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts`

### Kept
- `examples/yjs-size-benchmark/` - Pure Yjs benchmark, no `@epicenter/hq` dependencies
- `packages/epicenter/scripts/yjs-data-structure-benchmark.ts` - Pure Yjs benchmark
- `packages/epicenter/scripts/demo-yjs-nested-map-lww.ts` - Pure Yjs demonstration
- `packages/epicenter/scripts/yjs-gc-benchmark.ts` - Pure Yjs benchmark
- `packages/epicenter/scripts/ymap-vs-ykeyvalue-benchmark.ts` - Uses internal `y-keyvalue-lww` utility
- `packages/epicenter/scripts/ykeyvalue-write-benchmark.ts` - Uses internal `y-keyvalue-lww` utility

### Public API Status
The following types were already exported from `@epicenter/hq`:
- `DateTimeString` (with companion object methods `.parse()`, `.stringify()`, `.now()`)
- `ExtensionContext`
- `ProviderContext`

---

## Original Analysis

**CRITICAL FINDING**: The example workspace files use a `defineWorkspace` API pattern that **does not exist** in the codebase:

```typescript
// THE EXAMPLES USE THIS (NON-EXISTENT):
defineWorkspace({
  id: 'workspace',
  tables: { tableName: { field: fieldFactory() } },  // Object-based
  providers: { sqlite: (c) => sqliteProvider(c) },   // ← DOESN'T EXIST
  actions: ({ tables, providers }) => ({...}),       // ← DOESN'T EXIST
});
```

Neither the **static API** (`@epicenter/hq/static`) nor the **dynamic API** (`@epicenter/hq/dynamic`) supports this pattern. The examples require **complete rewrites** or **deletion**.

### Actual Available APIs

**Dynamic API** (`@epicenter/hq/dynamic`):
```typescript
const definition = defineWorkspace({
  id: 'my-app',
  name: 'My App',
  tables: [table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] })],
  kv: [],
});
const client = createWorkspace({ headDoc, definition }).withExtensions({ sqlite, persistence });
```

**Static API** (`@epicenter/hq/static`):
```typescript
const posts = defineTable(type({ id: 'string', title: 'string' }));
const client = createWorkspace({ id: 'my-app', tables: { posts } }).withExtensions({ sqlite });
```

### Additional Issues

1. **Outdated import paths** (`/providers/` → `/extensions/`)
2. **Removed/renamed exports** (`DateWithTimezone` → `DateTimeString`, function renames)
3. **Field factories require `id`** option: `text({ id: 'title' })` not `text()`

## Affected Files

### examples/content-hub/.epicenter/workspaces/

| File | Severity | Issues |
|------|----------|--------|
| `browser.workspace.ts` | Medium | Outdated import paths, renamed functions |
| `clippings.workspace.ts` | High | Removed exports (`DateWithTimezone*`), import paths, renamed functions |
| `epicenter.workspace.ts` | Medium | Outdated import paths, renamed functions |
| `gmail.workspace.ts` | High | Root-level imports of non-exported items, missing `type` import |
| `journal.workspace.ts` | Medium | Outdated import paths, renamed functions |
| `pages.workspace.ts` | High | Removed export (`DateWithTimezone`), import paths |
| `posts.workspace.ts` | Medium | Outdated import paths, renamed functions |
| `whispering.workspace.ts` | High | Removed export (`DateWithTimezone`), import paths |
| `wiki.workspace.ts` | High | Removed exports (`DateWithTimezone*`, `SerializedRow`), import paths |

### examples/basic-workspace/.epicenter/workspaces/

| File | Severity | Issues |
|------|----------|--------|
| `blog.workspace.ts` | Critical | Uses non-existent `/capabilities/` path, old builder pattern (`.withCapabilities()`, `.withActions()`), removed `SerializedRow` type |

### examples/stress-test/.epicenter/workspaces/

| File | Severity | Issues |
|------|----------|--------|
| `stress.workspace.ts` | Medium | Outdated import paths |

### packages/epicenter/scripts/

| File | Severity | Issues |
|------|----------|--------|
| `email-storage-simulation.ts` | Critical | Old workspace API (array tables with `id` in field options), old `createClient` builder pattern |
| `email-minimal-simulation.ts` | Critical | Same as above |
| `yjs-vs-sqlite-comparison.ts` | Critical | Same as above |
| `ymap-vs-ykeyvalue-benchmark.ts` | Low | Uses internal `y-keyvalue` utility (may be fine) |
| `yjs-data-structure-benchmark.ts` | None | Pure Yjs benchmark, no @epicenter/hq imports |
| `demo-yjs-nested-map-lww.ts` | Unknown | Needs review |
| `yjs-gc-benchmark.ts` | Unknown | Needs review |
| `ykeyvalue-write-benchmark.ts` | Unknown | Needs review |

## Error Categories

### Category 1: Outdated Import Paths

**Problem**: Import paths use old `/providers/` or `/capabilities/` subdirectories.

**Current package.json exports**:
```json
{
  "./extensions/persistence": "...",
  "./extensions/markdown": "...",
  "./extensions/sqlite": "..."
}
```

**Affected patterns**:
```typescript
// OLD (broken)
import { ... } from '@epicenter/hq/providers/markdown';
import { ... } from '@epicenter/hq/providers/persistence';
import { ... } from '@epicenter/hq/providers/sqlite';
import { ... } from '@epicenter/hq/capabilities/markdown';

// NEW (correct)
import { ... } from '@epicenter/hq/extensions/markdown';
import { ... } from '@epicenter/hq/extensions/persistence';
import { ... } from '@epicenter/hq/extensions/sqlite';
```

**Files affected**: 12 files

### Category 2: Renamed Function Exports

**Problem**: Extension factory functions were renamed for consistency.

| Old Name | New Name | Export Path |
|----------|----------|-------------|
| `markdownProvider` | `markdown` | `@epicenter/hq/extensions/markdown` |
| `sqliteProvider` | `sqlite` | `@epicenter/hq/extensions/sqlite` |
| `setupPersistence` | `persistence` | `@epicenter/hq/extensions/persistence` |
| `MarkdownProviderErr` | `MarkdownExtensionErr` | `@epicenter/hq/extensions/markdown` |

**Files affected**: 11 files

### Category 3: Removed/Non-Exported Types

**Problem**: Certain types/utilities are no longer exported from `@epicenter/hq` root.

| Missing Export | Status | Recommendation |
|----------------|--------|----------------|
| `DateWithTimezone` | Not exported | Use `Temporal.ZonedDateTime` or ISO strings with manual timezone handling |
| `DateWithTimezoneFromString` | Not exported | Parse manually or add back as utility |
| `DateWithTimezoneString` | Not exported (type) | Define locally or use string type |
| `SerializedRow` | Not exported | Import from internal path or use `Row<T>` type |
| `WorkspaceSchema` | Not exported | Use `WorkspaceDefinition` type |
| `ProviderContext` | Not exported | Import from `@epicenter/hq/dynamic` subpath |

**Files affected**: 6 files

### Category 4: Incompatible Workspace Definition API

**Problem**: The `basic-workspace/blog.workspace.ts` uses a completely different API pattern that no longer exists.

**Old API (broken)**:
```typescript
defineWorkspace({
  id: generateGuid(),
  slug: 'blog',
  name: 'Blog',
  kv: {},
  tables: { posts: { ... } },
})
.withCapabilities({
  persistence: (ctx) => persistence(ctx, {...}),
  sqlite: (ctx) => sqlite(ctx, {...}),
  markdown: (ctx) => markdown(ctx, {...}),
})
.withActions({
  getPublishedPosts: defineQuery({...}),
  createPost: defineMutation({...}),
});
```

**Current API**:
```typescript
defineWorkspace({
  id: 'blog',
  name: 'Blog',
  description: '',
  icon: null,
  tables: [
    table({
      id: 'posts',
      name: 'Posts',
      fields: [id(), text({ id: 'title' }), ...],
    }),
  ],
  kv: [],
});
```

**Note**: The current API uses:
- Array-based `tables` with `table()` factory
- Array-based `kv`
- `id` option in field factories: `text({ id: 'title' })`
- Separate client creation (not chained)

**Files affected**: 1 file (`blog.workspace.ts`)

### Category 5: Old Scripts API (createClient Builder Pattern)

**Problem**: Scripts use `createClient(head).withDefinition().withExtensions()` builder pattern.

**Old API (broken)**:
```typescript
const head = createHeadDoc({ workspaceId: 'emails', providers: {} });
await using client = await createClient(head)
  .withDefinition(emailDefinition)
  .withExtensions({
    persistence: (ctx) => persistence(ctx, { filePath: YJS_PATH }),
  });

// Access via:
client.tables.get('emails').upsertMany(emails);
```

**Files affected**: 3 scripts (`email-storage-simulation.ts`, `email-minimal-simulation.ts`, `yjs-vs-sqlite-comparison.ts`)

## Recommendations

### Option A: Delete Outdated Examples/Scripts

**Candidates for deletion**:
- `examples/basic-workspace/` - Uses completely different API, would require full rewrite
- `packages/epicenter/scripts/email-*.ts` - Simulation scripts likely not actively used
- `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts` - Benchmark script

**Reasoning**: These files use fundamentally different API patterns. Fixing them would essentially mean rewriting them entirely. If they're not actively used, deletion is cleaner.

### Option B: Update to Current API

For files that can be updated with find-and-replace style fixes:

1. **Import path fixes** - Simple search/replace
2. **Function name fixes** - Simple search/replace
3. **Missing exports** - Either:
   - Add back to public API if commonly needed
   - Import from internal paths (not recommended for examples)
   - Implement inline alternatives

### Option C: Hybrid Approach (Recommended)

**Delete**:
- `examples/basic-workspace/` - Fundamentally incompatible API
- `packages/epicenter/scripts/email-storage-simulation.ts`
- `packages/epicenter/scripts/email-minimal-simulation.ts`
- `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts`

**Update**:
- All `examples/content-hub/` workspaces - Import paths and function names only
- `examples/stress-test/` - Import paths only

**Requires deeper analysis**:
- Files using `DateWithTimezone` utilities - Decide if these should be re-exported
- `packages/epicenter/scripts/ymap-vs-ykeyvalue-benchmark.ts` - Uses internal utility
- Other benchmark scripts

## Execution Phases

### Phase 1: Import Path Fixes (Parallel Safe)

Update import paths in all files simultaneously:

```bash
# Pattern: @epicenter/hq/providers/* → @epicenter/hq/extensions/*
```

Files: All 12 workspace files in examples/

### Phase 2: Function Rename Fixes (Parallel Safe)

Rename function calls:

| Find | Replace |
|------|---------|
| `markdownProvider` | `markdown` |
| `sqliteProvider` | `sqlite` |
| `setupPersistence` | `persistence` |
| `MarkdownProviderErr` | `MarkdownExtensionErr` |

Files: Same 12 workspace files

### Phase 3: Delete Incompatible Files (Sequential)

Delete files that require complete rewrites:

- `examples/basic-workspace/` (entire directory)
- `packages/epicenter/scripts/email-storage-simulation.ts`
- `packages/epicenter/scripts/email-minimal-simulation.ts`
- `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts`

### Phase 4: DateWithTimezone Resolution (Requires Decision)

**Option 4A**: Re-export `DateWithTimezone` utilities from `@epicenter/hq`

**Option 4B**: Replace with inline implementations:
```typescript
// Instead of:
DateWithTimezone({ date: new Date(), timezone: 'UTC' }).toJSON()

// Use:
new Date().toISOString() // For UTC
// Or define local helper
```

**Option 4C**: Use `Temporal.ZonedDateTime` (modern API)

Files needing this: 5 workspace files

### Phase 5: gmail.workspace.ts Special Handling

This file imports non-exported items from root:
```typescript
import {
  markdownProvider,      // Should come from extensions/markdown
  sqliteProvider,        // Should come from extensions/sqlite
  type ProviderContext,  // Not publicly exported
  type WorkspaceSchema,  // Not publicly exported
} from '@epicenter/hq';
```

Options:
1. Export `ProviderContext` and `WorkspaceSchema` from public API
2. Remove/rewrite the custom `gmailAuthProvider` that uses these types
3. Import from internal subpaths (not recommended for examples)

## Open Questions

1. Should `DateWithTimezone` utilities be re-exported? They're used in 5 workspace files.

2. Should `basic-workspace/` be deleted or rewritten? It would need complete rewrite for current API.

3. Should benchmark scripts be maintained? They test internal implementation details.

4. Should `ProviderContext` and `WorkspaceSchema` be added to public API for custom provider support?

5. Are the `examples/content-hub/` workspaces actively used? If not, deletion may be appropriate.

## Success Criteria

After fixes are applied:

1. `bun run typecheck` passes for all example packages
2. No imports from non-existent paths (`/providers/`, `/capabilities/`)
3. No imports of non-exported types from root
4. All remaining examples demonstrate current API patterns

## Appendix: File-by-File Analysis

### examples/content-hub/.epicenter/workspaces/browser.workspace.ts

**Lines 34-36**:
```typescript
import {
  domainTitleFilenameSerializer,
  markdownProvider,
} from '@epicenter/hq/providers/markdown';
import { sqliteProvider } from '@epicenter/hq/providers/sqlite';
```

**Fix**:
```typescript
import {
  domainTitleFilenameSerializer,
  markdown,
} from '@epicenter/hq/extensions/markdown';
import { sqlite } from '@epicenter/hq/extensions/sqlite';
```

Also update usages: `markdownProvider` → `markdown`, `sqliteProvider` → `sqlite`

---

### examples/content-hub/.epicenter/workspaces/clippings.workspace.ts

**Lines 3-21**:
```typescript
import {
  DateWithTimezone,
  DateWithTimezoneFromString,
  DateWithTimezoneString,
  // ... other imports
} from '@epicenter/hq';
import { bodyFieldSerializer, MarkdownProviderErr, markdownProvider } from '@epicenter/hq/providers/markdown';
import { setupPersistence } from '@epicenter/hq/providers/persistence';
import { sqliteProvider } from '@epicenter/hq/providers/sqlite';
```

**Issues**:
- `DateWithTimezone`, `DateWithTimezoneFromString`, `DateWithTimezoneString` not exported
- Wrong import paths
- Wrong function names

**Fix requires**: Decision on DateWithTimezone strategy

---

### examples/basic-workspace/.epicenter/workspaces/blog.workspace.ts

**Critical**: Uses completely different API that doesn't exist.

**Recommendation**: DELETE entire `examples/basic-workspace/` directory

---

### packages/epicenter/scripts/email-storage-simulation.ts

**Lines 18-28**:
```typescript
import { persistence } from '../src/extensions/persistence/desktop';
import {
  createClient,
  createHeadDoc,
  defineWorkspace,
  generateId,
  id,
  integer,
  table,
  text,
} from '../src/index';
```

**Lines 188-226** use old API:
```typescript
const emailDefinition = defineWorkspace({
  name: 'Email Storage Simulation',
  tables: [
    table({
      id: 'emails',
      name: 'Emails',
      fields: [
        id(),
        text({ id: 'sender' }),
        // ...
      ] as const,
    }),
  ],
  kv: [],
});

const head = createHeadDoc({ workspaceId: 'emails', providers: {} });
await using client = await createClient(head)
  .withDefinition(emailDefinition)
  .withExtensions({...});
```

**Recommendation**: DELETE - Uses non-existent builder pattern

---

### packages/epicenter/scripts/yjs-data-structure-benchmark.ts

**No @epicenter/hq imports** - Pure Yjs benchmark, should still work.

---

### packages/epicenter/scripts/ymap-vs-ykeyvalue-benchmark.ts

**Line 13**:
```typescript
import { YKeyValue } from '../src/core/utils/y-keyvalue';
```

**Status**: Uses internal utility. May work if path is correct. Needs verification.
