# Handoff Prompt: Implement `@epicenter/skills` Package

## Task

Implement the `@epicenter/skills` package at `packages/skills/` following the spec at `specs/20260330T120000-portable-skills-architecture.md`. This package provides workspace table definitions for agent skills (1:1 mapping to the [agentskills.io](https://agentskills.io/specification) spec), pure functions to parse/serialize SKILL.md files, and import/export to disk.

The directory `packages/skills/src/` already exists but is empty. You're building from scratch.

Execute this work on the current branch `refactor/auth-transport-typed-errors`. Do not create a new branch.

## Context

### What this codebase is

Epicenter is a local-first monorepo. `packages/workspace` provides Yjs CRDT-backed tables (`defineTable`) that work in browser (IndexedDB), server (filesystem), and edge (Cloudflare Workers). Tables support schema validation via arktype, versioning with `_v`, and per-row Y.Doc content documents via `.withDocument()`.

### How `defineTable` works

Tables use arktype schemas. Every row must have `id: 'string'` and `_v: '<number>'`. Optional fields use arktype's `'key?': 'type | undefined'` syntax.

```typescript
import { defineTable, type InferTableRow } from '@epicenter/workspace'
import { type } from 'arktype'

const notesTable = defineTable(
  type({
    id: 'string',
    title: 'string',
    'preview?': 'string | undefined',
    pinned: 'boolean',
    updatedAt: 'number',
    _v: '1',
  }),
  type({
    id: 'string',
    title: 'string',
    'preview?': 'string | undefined',
    pinned: 'boolean',
    'deletedAt?': 'number | undefined',
    updatedAt: 'number',
    _v: '2',
  }),
).migrate((row) => {
  switch (row._v) {
    case 1: return { ...row, deletedAt: undefined, _v: 2 }
    case 2: return row
  }
}).withDocument('body', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: Date.now() }),
})
export type Note = InferTableRow<typeof notesTable>
```

`.withDocument('name', { guid, onUpdate })` attaches a per-row Y.Doc. The document content is NOT a column. It's accessed via `ws.documents.{table}.{name}.get(rowId)`, which returns a handle with `.read()` (string), `.writeText()` (set string), `.asText()` (Y.Text for editor binding).

### How workspaces compose tables

```typescript
import { defineWorkspace, createWorkspace } from '@epicenter/workspace'

export const myWorkspace = defineWorkspace({
  id: 'epicenter.skills',
  tables: { skills: skillsTable, references: referencesTable },
  kv: {},
})

const ws = createWorkspace(myWorkspace)
ws.tables.get('skills').getAllValid()  // Skill[]
ws.tables.get('skills').get({ id: 'abc' })  // { status: 'valid', row } | { status: 'not_found', id }
ws.tables.get('references').filter(r => r.skillId === 'abc')  // Reference[]
```

### What SKILL.md files look like on disk

The 49 existing skills live in `.agents/skills/`. Every skill has a folder with a `SKILL.md` file (YAML frontmatter + markdown body). Some have a `references/` directory with additional markdown files.

Example: `.agents/skills/svelte/SKILL.md`:
```yaml
---
name: svelte
description: Svelte 5 patterns including runes ($state, $derived, $props), TanStack Query...
metadata:
  author: epicenter
  version: '2.0'
---

# Svelte Guidelines

## When to Apply This Skill
...
```

Example: `.agents/skills/encryption/SKILL.md` (no metadata):
```yaml
---
name: encryption
description: Encryption patterns for HKDF key derivation, XChaCha20-Poly1305...
---

# Encryption Patterns
...
```

The `svelte` skill has references:
```
.agents/skills/svelte/references/
├── component-patterns.md
├── loading-empty-states.md
├── reactive-state-pattern.md
├── shadcn-patterns.md
└── tanstack-query-mutations.md
```

Most skills only have `name`, `description`, and optionally `metadata` in frontmatter. The optional fields `license`, `compatibility`, and `allowed-tools` are unused across all 49 skills but should be supported.

### Package boilerplate convention

All packages use this pattern:

`package.json`:
```json
{
  "name": "@epicenter/skills",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "license": "MIT",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@epicenter/workspace": "workspace:*",
    "arktype": "catalog:",
    "wellcrafted": "catalog:"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:",
    "yjs": "catalog:"
  },
  "peerDependencies": {
    "yjs": "catalog:"
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "preserve",
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noPropertyAccessFromIndexSignature": false
  }
}
```

### Codebase conventions

- Always use `type` instead of `interface`
- Use `bun` everywhere (not npm/yarn/node)
- Em dashes are closed (no spaces): `word. Word`
- JSDoc is STRONGLY ENCOURAGED on all public APIs with `@example` blocks
- Use `.js` extensions in relative imports (TypeScript with `"module": "preserve"`)

## Design Requirements

Read `specs/20260330T120000-portable-skills-architecture.md` for the full spec. Key points:

### 1. Table Schema (`src/tables.ts`)

Two tables, both with `.withDocument()`:

**`skillsTable`**: one row per skill, 1:1 with SKILL.md frontmatter:
- `id: 'string'`: nanoid (stable FK for child rows)
- `name: 'string'`: agentskills.io slug (lowercase, hyphens, 1-64 chars)
- `description: 'string'`: 1-1024 chars
- `'license?': 'string | undefined'`
- `'compatibility?': 'string | undefined'`
- `'metadata?': 'string | undefined'`: JSON stringified `Record<string, string>`
- `'allowedTools?': 'string | undefined'`: space-delimited
- `updatedAt: 'number'`
- `_v: '1'`
- `.withDocument('instructions', { guid: 'id', onUpdate: () => ({ updatedAt: Date.now() }) })`

**`referencesTable`**: one row per markdown file in `references/`:
- `id: 'string'`: nanoid
- `skillId: 'string'`: FK to skills.id
- `path: 'string'`: filename relative to references/ (e.g., `"component-patterns.md"`)
- `updatedAt: 'number'`
- `_v: '1'`
- `.withDocument('content', { guid: 'id', onUpdate: () => ({ updatedAt: Date.now() }) })`

Also include `scriptsTable` and `assetsTable` as **commented-out deferred definitions** with JSDoc explaining they're spec'd but not implemented in v1. These do NOT have `.withDocument()`: they use a plain `content: 'string'` column.

### 2. Types (`src/types.ts`)

Export `Skill`, `Reference`, `Script`, `Asset` types via `InferTableRow`. Add JSDoc explaining the 1:1 mapping to agentskills.io.

### 3. Parse (`src/parse.ts`)

`parseSkillMd(name: string, content: string)`: splits YAML frontmatter from markdown body. Returns `{ skill: Omit<Skill, 'id'> & { id?: undefined }, instructions: string }` (caller provides the id, or generates one on import). Use a simple frontmatter parser: split on `---` delimiters, parse YAML. You can use `yaml` package or write a minimal parser.

`parseReferenceMd(skillId: string, path: string, content: string)`: creates a reference row + content string.

### 4. Serialize (`src/serialize.ts`)

`serializeSkillMd(skill: Skill, instructions: string)`: reconstructs SKILL.md from row + document text. Only includes non-undefined optional fields in frontmatter.

`serializeReferenceMd(content: string)`: trivial (just returns the string), but exists for symmetry and future processing.

### 5. Import (`src/import.ts`)

`importFromDisk(dir: string, workspace)`: scans a directory for skill folders, parses SKILL.md files, upserts into workspace tables, writes instruction documents. Also imports `references/` files. Matches by `name` on re-import to avoid duplicates (updates existing rows).

### 6. Export (`src/export.ts`)

`exportToDisk(workspace, dir: string)`: reads all skills, serializes to SKILL.md, writes reference files. Cleans up folders for deleted skills.

### 7. Index (`src/index.ts`)

Re-export everything: tables, types, parse, serialize, import, export.

## MUST DO

- Read `specs/20260330T120000-portable-skills-architecture.md` before writing any code
- Load the skills `workspace-api`, `typescript`, `documentation`, `testing`, `factory-function-composition`, and `arktype` for codebase conventions
- Use `defineTable` from `@epicenter/workspace` with arktype `type()` schemas
- Use `.withDocument()` on `skillsTable` and `referencesTable`
- Use `type` not `interface` everywhere
- Use `.js` extensions in all relative imports
- Add detailed JSDoc with `@example` blocks on every exported function and type
- Include `scriptsTable` and `assetsTable` as commented-out code with JSDoc explaining they're deferred
- Add `package.json` and `tsconfig.json` following the boilerplate convention above
- On import, match existing skills by `name` to support re-import without duplication
- On export, only include non-undefined optional frontmatter fields
- Run `bun run typecheck` in `packages/skills/` to verify no type errors
- After implementation, run `bun install` from the repo root to register the new package
- Leave all changes on the current branch `refactor/auth-transport-typed-errors`

## MUST NOT DO

- Do not install new dependencies beyond what's listed in the package.json template above (add `yaml` or a YAML parser if needed for frontmatter: check what's available in the monorepo first)
- Do not modify any files outside `packages/skills/`
- Do not use `interface`: use `type` exclusively
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Do not build the skills editor UI: this is the package only
- Do not implement filesystem watchers or bidirectional sync
- Do not create test files in this pass (we'll add tests separately)
- Do not modify the spec file
- Do not create or switch branches
