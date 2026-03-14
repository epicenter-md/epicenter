# Branded ID Convention: Three-Part Pattern

## Problem

Branded ID types in the codebase lack a consistent construction pattern. Currently:

- The **type** (`type SavedTabId = string & Brand<'SavedTabId'>`) used `string` as the base—requiring a double-cast to convert from `Id`
- The **arktype validator** (`const SavedTabId = type('string').pipe(...)`) exists for types used in `defineTable()` schemas
- **No factory function** exists—every call site uses the ugly double-cast: `generateId() as string as SavedTabId`

The double-cast existed because `Id` (`string & Brand<'Id'>`) and `SavedTabId` (`string & Brand<'SavedTabId'>`) have incompatible brands. By extending `Id` instead of `string`, the cast becomes single-step. Combined with factory functions (matching `packages/filesystem`'s existing convention), the cast is fully encapsulated.

## Convention

Every branded ID type that is generated at runtime MUST follow the three-part pattern:

```typescript
import { type Brand } from 'wellcrafted/brand';
import { type } from 'arktype';
import { generateId, type Id } from '@epicenter/workspace';

// 1. TYPE — extends Id for single-cast generation
export type SavedTabId = Id & Brand<'SavedTabId'>;

// 2. VALIDATOR — type-only cast via .as<T>() (zero runtime overhead)
export const SavedTabId = type('string').as<SavedTabId>();

// 3. FACTORY — generate* prefix, single-cast thanks to Id base
export const generateSavedTabId = (): SavedTabId =>
    generateId() as SavedTabId;
```

### Naming Rules

| Part | Naming | Example |
|------|--------|---------|
| Type | PascalCase | `SavedTabId` |
| Validator | Same PascalCase (TypeScript allows type+value same name) | `SavedTabId` |
| Factory | `generate` + PascalCase | `generateSavedTabId` |

### When Each Part Is Needed

| Part | Required When |
|------|--------------|
| Type | Always — this IS the branded type |
| Validator | Used in `defineTable()` or other arktype schemas |
| Factory | IDs are generated at runtime (via `generateId()` or similar) |

Not every branded type needs all three. Path types like `AbsolutePath`, `ProjectDir` are cast from external sources—they need only the type. Composite IDs like `TabCompositeId` already have `createTabCompositeId()` factories.

---

## Inventory of Branded IDs Requiring `create*` Factories

### apps/tab-manager/src/lib/workspace.ts

| Type | Has Type | Has Validator | Has Factory | Needs Factory | Call Sites |
|------|----------|---------------|-------------|---------------|------------|
| `DeviceId` | ✅ | ✅ | ❌ | ❌ (set from external source) | — |
| `SavedTabId` | ✅ | ✅ | ❌ | ✅ | tab-actions.ts:104, saved-tab-state.svelte.ts:93 |
| `BookmarkId` | ✅ | ✅ | ❌ | ✅ | bookmark-state.svelte.ts:84 |
| `ConversationId` | ✅ | ✅ | ❌ | ✅ | chat-state.svelte.ts:87 |
| `ChatMessageId` | ✅ | ✅ | ❌ | ✅ | chat-state.svelte.ts:361 |
| `TabCompositeId` | ✅ | ✅ | ✅ (`createTabCompositeId`) | — | Already done |
| `WindowCompositeId` | ✅ | ✅ | ✅ (`createWindowCompositeId`) | — | Already done |
| `GroupCompositeId` | ✅ | ✅ | ✅ (`createGroupCompositeId`) | — | Already done |

### packages/filesystem/src/ids.ts (already follows this convention)

| Type | Has Type | Has Validator | Has Factory |
|------|----------|---------------|-------------|
| `FileId` | ✅ | ✅ | ✅ (`generateFileId`) |
| `RowId` | ✅ | ❌ | ✅ (`generateRowId`) |
| `ColumnId` | ✅ | ❌ | ✅ (`generateColumnId`) |

### packages/workspace/src/shared/id.ts (already follows this convention)

| Type | Has Type | Has Validator | Has Factory |
|------|----------|---------------|-------------|
| `Id` | ✅ | ❌ | ✅ (`generateId`) |
| `Guid` | ✅ | ❌ | ✅ (`generateGuid`) |

---

## Implementation Plan

### Wave 1: Add factory functions (workspace.ts)

- [x] Add `generateSavedTabId` to `apps/tab-manager/src/lib/workspace.ts`
- [x] Add `generateBookmarkId` to `apps/tab-manager/src/lib/workspace.ts`
- [x] Add `generateConversationId` to `apps/tab-manager/src/lib/workspace.ts`
- [x] Add `generateChatMessageId` to `apps/tab-manager/src/lib/workspace.ts`

### Wave 2: Replace double-casts at call sites

- [x] `apps/tab-manager/src/lib/tab-actions.ts:179` — `generateId() as string as SavedTabId` → `generateSavedTabId()`
- [x] `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts:93` — same
- [x] `apps/tab-manager/src/lib/state/bookmark-state.svelte.ts:84` — `generateId() as string as BookmarkId` → `generateBookmarkId()`
- [x] `apps/tab-manager/src/lib/state/chat-state.svelte.ts:87` — `generateConversationId` wrapper removed, replaced with `generateConversationId()`
- [x] `apps/tab-manager/src/lib/state/chat-state.svelte.ts:361` — `generateId() as string as ChatMessageId` → `generateChatMessageId()`

### Wave 3: Update skills and documentation

- [x] Update `.agents/skills/typescript/SKILL.md` — branded types section to document `create*` factory convention
- [x] Update `.agents/skills/workspace-api/SKILL.md` — branded table IDs section to use factories instead of double-casts
- [x] Update JSDoc on each factory function with `@example` blocks

---

## Review

Six commits landed:

1. `feat(tab-manager): add generate* factory functions for branded ID types` — added `generateId` import and 4 factories co-located with their type+validator pairs in `workspace.ts`.
2. `refactor(tab-manager): replace double-cast ID generation with generate* factories` — replaced all 5 double-cast call sites across 4 files. Removed the local `generateConversationId` wrapper in `chat-state.svelte.ts`.
3. `docs(tab-manager): add JSDoc with @example blocks to generate* ID factories` — each factory has a description, `{@link}`, and a realistic `@example` block.
4. `docs(skills): update typescript and workspace-api skills with branded ID factory convention` — documented the three-part pattern in both skills.
5. `refactor(tab-manager): rename create* ID factories to generate* for cross-package consistency` — aligned with `packages/filesystem` naming convention.
6. `refactor(tab-manager): extend Id instead of string in branded types to eliminate double-cast` — changed type definitions from `string & Brand<'*'>` to `Id & Brand<'*'>`, enabling single-cast `generateId() as *Id` inside factories. Matches the pattern in `packages/filesystem/src/ids.ts`.

Additional changes (session 2):

7. `refactor(tab-manager): replace .pipe() validators with .as<>() for zero-cost type casts` — all branded ID validators in `workspace.ts` updated from `type('string').pipe((s): T => s as T)` to `type('string').as<T>()`.
8. `docs(skills): update typescript and workspace-api skills with generate* + .as<>() convention` — skills now show `Id & Brand<>`, `.as<>()`, and `generate*` as the canonical pattern.
9. `docs(articles): add validator+generator variant to same-name-for-type-and-value.md` — added the fourth same-name variant (type + validator + generator) with summary table row.
10. `docs(articles): create three-part-branded-id-pattern.md` — standalone article documenting the type + validator + generator convention with rationale for `Id &` vs `string &`, `.as<>()` vs `.pipe()`, and `generate*` vs `create*`.

### Naming Decision

The spec originally proposed `create*` prefix for factories. During implementation, we chose `generate*` instead to match the existing codebase convention (`generateId`, `generateGuid`, `generateFileId`, `generateRowId`, `generateColumnId`). The semantic distinction: `generate*` = new ID from scratch, `create*` = assemble from inputs.
