# Specification: Dynamic Workspace Architecture Simplification

**Status**: Final (2026-01-31)

## Overview

Simplify the dynamic workspace architecture by:

1. Moving schema/definition storage OUT of Y.Doc (to static JSON)
2. Removing meta (name/icon/description) from Head Doc
3. Adding TypeBox validation for WorkspaceDefinition
4. Changing KV storage from Y.Map to Y.Array with YKeyValueLww

---

## 1. WorkspaceDefinition Schema (REFACTOR)

### 1.1 Unified WorkspaceDefinition Type

The WorkspaceDefinition is a complete, static JSON schema that includes ALL workspace identity information.

**Decision**: Workspace name/icon/description is immutable after load. It comes from the passed-in WorkspaceDefinition (Option A from original questions).

```typescript
// Location: core/schema/workspace-definition.ts (REFACTOR)
export type WorkspaceDefinition<
	TTableDefinitions extends readonly TableDefinition[] = TableDefinition[],
	TKvFields extends readonly KvField[] = KvField[],
> = {
	/** Unique workspace identifier (e.g., 'epicenter.whispering') */
	id: string;
	/** Display name of the workspace */
	name: string;
	/** Description of the workspace */
	description: string;
	/** Icon for the workspace - tagged string format 'type:value' or null */
	icon: Icon | null;
	/** Table definitions as array */
	tables: TTableDefinitions;
	/** KV field definitions as array */
	kv: TKvFields;
};
```

### 1.2 TypeBox Validation Schema

Create a TypeBox schema to validate workspace definitions at runtime.

**Decision**: Use TypeBox validator directly instead of a WorkspaceDefinitionFile abstraction. Load the file, parse with TypeBox, and pass the validated definition through.

````typescript
// Location: core/schema/workspace-definition-validator.ts (NEW FILE)
import { Type, type Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

export const WorkspaceDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String(),
	description: Type.String(),
	icon: Type.Union([
		Type.TemplateLiteral('emoji:${string}'),
		Type.TemplateLiteral('lucide:${string}'),
		Type.TemplateLiteral('url:${string}'),
		Type.Null(),
	]),
	tables: Type.Array(TableDefinitionSchema),
	kv: Type.Array(KvFieldSchema),
});

export type WorkspaceDefinitionInput = Static<typeof WorkspaceDefinitionSchema>;

// Compiled validator for JIT-optimized validation
export const WorkspaceDefinitionValidator = TypeCompiler.Compile(
	WorkspaceDefinitionSchema,
);

/**
 * Validate a workspace definition at runtime.
 *
 * Use this when loading workspace definitions from JSON files or external sources.
 * If the definition is already statically typed by TypeScript, validation is optional
 * but recommended for defense-in-depth.
 *
 * @example
 * ```typescript
 * const json = await Bun.file('workspace.json').json();
 * const result = validateWorkspaceDefinition(json);
 * if (result.ok) {
 *   const workspace = createClient(result.data);
 * } else {
 *   console.error('Invalid definition:', result.errors);
 * }
 * ```
 */
export function validateWorkspaceDefinition(
	value: unknown,
):
	| { ok: true; data: WorkspaceDefinitionInput }
	| { ok: false; errors: ValueError[] } {
	if (WorkspaceDefinitionValidator.Check(value)) {
		return { ok: true, data: value };
	}
	return { ok: false, errors: [...WorkspaceDefinitionValidator.Errors(value)] };
}
````

### 1.3 Validation Timing

**Decision**:

- **Definition validation** happens at workspace creation time (when calling `createClient()`)
- **Value validation** (KV and table data) continues to happen on read, as before

Definition validation ensures the schema structure is valid before creating the workspace. If the definition is already statically typed by TypeScript, this is a defense-in-depth check. If loading from an unknown JSON file, this catches malformed definitions early.

---

## 2. Head Doc Changes

### 2.1 REMOVE from head-doc.ts

| Item                      | Line(s)    | Action |
| ------------------------- | ---------- | ------ |
| `WorkspaceMeta` type      | 20-27      | DELETE |
| `metaMap` initialization  | 123        | DELETE |
| `getMeta()` method        | 381-386    | DELETE |
| `setMeta()` method        | 410-420    | DELETE |
| `observeMeta()` method    | 442-448    | DELETE |
| `hasMeta()` method        | 471-473    | DELETE |
| Export of `WorkspaceMeta` | index.ts:1 | UPDATE |

### 2.2 Head Doc ONLY stores

- `Y.Map('epochs')` - per-client epoch proposals

The Head Doc becomes purely an epoch coordinator. Workspace identity (name/icon/description) comes from the static WorkspaceDefinition.

---

## 3. Workspace Doc Changes

### 3.1 REMOVE from workspace-doc.ts

| Item                                  | Line(s)  | Action |
| ------------------------------------- | -------- | ------ |
| `WORKSPACE_DOC_MAPS.DEFINITION`       | 33       | DELETE |
| `definitionMap` initialization        | 279-281  | DELETE |
| `definition.merge()` call             | 337-347  | DELETE |
| `definition` in return object         | 305, 364 | DELETE |
| `Definition` type in ExtensionContext | 192      | DELETE |

### 3.2 Workspace Y.Doc ONLY stores

- `Y.Array('kv')` with YKeyValueLww entries
- `Y.Array('table:{tableName}')` per table with YKeyValueLww entries

No schema/definition data in the Y.Doc. The Y.Doc is purely for collaborative data storage.

---

## 4. KV Storage Change

### 4.1 Current (CHANGE)

```typescript
// kv-helper.ts, core.ts
const ykvMap = ydoc.getMap<KvValue>('kv');
```

### 4.2 New (CORRECT)

```typescript
// kv-helper.ts, core.ts
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../core/utils/y-keyvalue-lww';

const yarray = ydoc.getArray<YKeyValueLwwEntry<KvValue>>('kv');
const ykv = new YKeyValueLww<KvValue>(yarray);
```

### 4.3 Files to modify

- `dynamic/kv/kv-helper.ts` (line 74)
- `dynamic/kv/core.ts` (line 184)
- All KV tests

**Why**: Using Y.Array + YKeyValueLww gives us proper LWW conflict resolution with timestamps, matching the pattern already used for tables. Y.Map's conflict resolution is based on clientID (higher ID wins), which can cause confusing behavior in offline-first scenarios.

---

## 5. Definition Helper Changes

### 5.1 definition-helper.ts (863 lines)

**Decision**: DELETE entirely.

The definition-helper was built to manipulate definitions stored IN the Y.Doc. Since definitions are now static JSON (not CRDT data), this entire file is unnecessary.

Extensions that need workspace metadata can access it via the static WorkspaceDefinition passed to `createClient()`.

---

## 6. Extension Context Changes

### 6.1 How Extensions Access Workspace Metadata

**Decision**: Static lookup via the WorkspaceDefinition passed to createClient.

```typescript
// Before
context.definition.tables.get('posts'); // Dynamic lookup via Y.Doc

// After
// Extensions receive the static definition in their context
type ExtensionContext<TTableDefs, TKvFields> = {
	ydoc: Y.Doc;
	workspaceId: string;
	epoch: number;
	tables: Tables<TTableDefs>; // Table helpers for data access
	kv: Kv<TKvFields>; // KV helpers for data access
	definition: WorkspaceDefinition<TTableDefs, TKvFields>; // Static definition
	extensionId: string;
};

// Extension usage
const sqlite: ExtensionFactory = ({ definition, tables }) => {
	// Access metadata from static definition
	const tableDef = definition.tables.find((t) => t.id === 'posts');

	// Access data via table helpers
	const allPosts = tables.get('posts').getAllValid();
};
```

**Design principle**: Keep one API. Extensions access:

- **Definition/metadata** via `context.definition` (static, from WorkspaceDefinition)
- **Data** via `context.tables` and `context.kv` (dynamic, from Y.Doc)

---

## 7. Files to Modify

### 7.1 Code Changes (by priority)

| Priority | File                                             | Change                                     |
| -------- | ------------------------------------------------ | ------------------------------------------ |
| P0       | `core/schema/workspace-definition.ts`            | Add `id` field, update type                |
| P0       | `core/schema/workspace-definition-validator.ts`  | NEW: TypeBox validation                    |
| P1       | `dynamic/head-doc.ts`                            | Remove meta map and all meta methods       |
| P1       | `dynamic/workspace-doc.ts`                       | Remove definition map, merge logic         |
| P1       | `dynamic/kv/kv-helper.ts`                        | Change Y.Map to Y.Array + YKeyValueLww     |
| P1       | `dynamic/kv/core.ts`                             | Change Y.Map to Y.Array + YKeyValueLww     |
| P2       | `dynamic/definition-helper/definition-helper.ts` | DELETE entirely                            |
| P2       | `dynamic/definition-helper/index.ts`             | DELETE or update exports                   |
| P2       | `dynamic/index.ts`                               | Update exports                             |
| P2       | `dynamic/workspace/index.ts`                     | Update exports                             |
| P3       | `core/schema/schema-file.ts`                     | Ensure parseSchema uses TypeBox validation |

### 7.2 Documentation Updates

| File                             | Section to Update                  |
| -------------------------------- | ---------------------------------- |
| `packages/epicenter/README.md`   | Y.Doc structure diagram (line 44)  |
| `dynamic/YDOC-ARCHITECTURE.md`   | Entire Y.Doc architecture section  |
| `dynamic/workspace/README.md`    | Storage architecture section       |
| `dynamic/workspace/workspace.ts` | JSDoc comments (lines 52-82)       |
| `dynamic/workspace-doc.ts`       | JSDoc comments (lines 47, 214-216) |
| `core/schema/README.md`          | WorkspaceDefinition section        |
| `static/README.md`               | May need alignment                 |

### 7.3 Test Files to Update

| Pattern                  | Files                           |
| ------------------------ | ------------------------------- |
| `**/kv*.test.ts`         | KV tests need Y.Array migration |
| `**/*workspace*.test.ts` | Remove definition merge tests   |
| `**/head-doc*.test.ts`   | Remove meta tests               |

---

## 8. API Changes Summary

### 8.1 Before (Current)

```typescript
// Definition passed separately, merged into Y.Doc
const client = createClient(workspaceId, { epoch })
  .withDefinition(definition)  // <-- merges into Y.Doc
  .withExtensions({ ... });

// Head Doc has meta
head.getMeta();  // { name, icon, description }
head.setMeta({ name: 'New Name' });

// Workspace Y.Doc stores definition
ydoc.getMap('definition')  // Contains tables/kv schemas
```

### 8.2 After (New)

```typescript
// Definition is static, passed for type safety (NOT stored in Y.Doc)
const definition = validateWorkspaceDefinition(jsonSchema);
if (!definition.ok) throw new Error('Invalid definition');

const client = createClient(definition.data)  // definition includes id
  .withExtensions({ ... });

// Head Doc ONLY has epochs
head.getEpoch();
head.bumpEpoch();
// NO getMeta/setMeta/observeMeta

// Workspace Y.Doc stores ONLY data
ydoc.getArray('kv')           // KV values with LWW
ydoc.getArray('table:posts')  // Table data with LWW
// NO getMap('definition')
```

---

## 9. Migration Path

### Phase 1: Add `id` to WorkspaceDefinition, create TypeBox validator

- Add `id: string` to WorkspaceDefinition type
- Create `workspace-definition-validator.ts` with TypeBox schemas
- Update `defineWorkspace()` to require `id`

### Phase 2: Remove meta from Head Doc (breaking change)

- Delete `WorkspaceMeta` type
- Delete `metaMap` and all meta methods
- Update Head Doc tests
- Update README

**Note (2026-01-31)**: After this spec was created, the `dynamic/docs/` folder was flattened. The file `head-doc.ts` is now at `dynamic/head-doc.ts` instead of `dynamic/docs/head-doc.ts`.

### Phase 3: Remove definition from Workspace Doc (breaking change)

- Delete `WORKSPACE_DOC_MAPS.DEFINITION`
- Delete definition merge logic
- Remove `definition` from ExtensionContext (replace with static access)
- Update workspace doc tests

**Note (2026-01-31)**: After this spec was created, the `dynamic/docs/` folder was flattened. The file `workspace-doc.ts` is now at `dynamic/workspace-doc.ts` instead of `dynamic/docs/workspace-doc.ts`.

### Phase 4: Change KV to Y.Array + YKeyValueLww

- Update `kv-helper.ts` to use Y.Array
- Update `core.ts` to use Y.Array
- Update KV tests
- Ensure existing KV data migration path (if needed)

### Phase 5: Delete definition-helper.ts

- Delete the file entirely
- Update exports in index.ts files
- Remove any remaining references

### Phase 6: Update all documentation

- README files
- JSDoc comments
- Architecture diagrams

---

## 10. Handoff Prompt for Coding Agent

```
## Task: Implement Dynamic Workspace Architecture Simplification

Read the specification at specs/20260131T140200-dynamic-workspace-architecture-simplification.md thoroughly before starting.

### Execution Order:

1. Create `core/schema/workspace-definition-validator.ts` with TypeBox validation
2. Update `core/schema/workspace-definition.ts` to add `id` field
3. Remove meta from `dynamic/docs/head-doc.ts` (delete WorkspaceMeta, getMeta, setMeta, observeMeta, hasMeta)
4. Remove definition map from `dynamic/docs/workspace-doc.ts` (delete definition merge logic)
5. Change KV from Y.Map to Y.Array+YKeyValueLww in `dynamic/kv/kv-helper.ts` and `dynamic/kv/core.ts`
6. Delete `dynamic/definition-helper/definition-helper.ts` and `dynamic/definition-helper/index.ts`
7. Update all exports in index.ts files
8. Update all tests
9. Update all README.md files

### Critical Rules:

- Run `bun test` after each file change to catch regressions
- The Y.Doc should ONLY contain data, never schema definitions
- Use YKeyValueLww pattern for KV (same pattern as tables)
- WorkspaceDefinition validation should use TypeBox Compile() for performance
- Definition validation happens at workspace creation time
- Value validation (KV/tables) continues to happen on read

### Verification:

- All tests pass
- No `Y.Map('definition')`, `Y.Map('meta')`, or `Y.Map('kv')` remain
- WorkspaceDefinition always includes `id`
- parseSchema() uses TypeBox validation
```

---

## 11. Success Criteria

- [ ] WorkspaceDefinition includes `id` field
- [ ] TypeBox validator exists for WorkspaceDefinition
- [ ] Head Doc has NO meta methods (getMeta, setMeta, observeMeta, hasMeta)
- [ ] Workspace Doc has NO definition map
- [ ] KV uses Y.Array + YKeyValueLww (not Y.Map)
- [ ] definition-helper.ts is deleted
- [ ] All tests pass
- [ ] README files updated with new Y.Doc structure

---

## 12. Review

**Status**: Specification created (2026-01-31)

**Note (2026-01-31)**: This specification was created to plan the architecture simplification. After the core reorganization and builder pattern implementation, the `dynamic/docs/` folder was subsequently flattened, moving `head-doc.ts`, `workspace-doc.ts`, and `provider-types.ts` directly into `dynamic/`. The file paths in this spec should be updated to reflect this flatten when implementing the architecture changes.
