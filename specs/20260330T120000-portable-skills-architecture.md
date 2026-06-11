# Portable Skills Architecture

**Date**: 2026-03-30
**Status**: Draft
**Author**: AI-assisted

## Overview

A shared `@epicenter/skills` package that lets any Epicenter app load, edit, and sync skills via workspace tables. Skills are a shared runtime resource. Consumed by browser apps, edge workers, and desktop apps. Not just agent tooling. Export to the [agentskills.io](https://agentskills.io/specification) folder format is a secondary publish step for Codex/Claude Code/OpenCode compatibility.

## Motivation

### Current State

We have ~49 skills in `.agents/skills/`, each following the agentskills.io specification:

```
.agents/skills/
├── svelte/
│   ├── SKILL.md              # YAML frontmatter + markdown instructions
│   └── references/
│       ├── component-patterns.md
│       ├── shadcn-patterns.md
│       └── tanstack-query-mutations.md
├── testing/
│   ├── SKILL.md
│   └── references/
│       └── setup-pattern.md
├── typescript/
│   └── SKILL.md
└── ... (46 more)
```

These work for agent runtimes that scan the filesystem. But browser apps, Cloudflare Workers, and edge runtimes can't read them. There's no shared loader, no sync, and no way to edit skills from a browser UI.

A draft skills editor exists at `apps/skills/` (PR #1556) using a disconnected Yjs virtual filesystem. It doesn't connect to the real `.agents/skills/` folders.

### Desired State

- Skills are a **shared runtime resource** available in any app context: browser, server, edge, desktop
- One shared package (`@epicenter/skills`) used by all apps
- Skills sync between contexts via Yjs CRDTs
- Skills can be authored/edited in a browser app with collaborative Y.Text editing
- Optional export to agentskills.io folder format for agent compatibility

## Research Findings

### How the Agent Skills Spec Works (agentskills.io)

The [specification](https://agentskills.io/specification) defines skills as directory packages:

```
skill-name/
├── SKILL.md          # Required: YAML frontmatter + markdown instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: additional documentation
└── assets/           # Optional: templates, images, data files
```

#### SKILL.md Frontmatter

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | Yes | string | 1-64 chars, lowercase + hyphens, must match parent dir |
| `description` | Yes | string | 1-1024 chars, describes what + when to use |
| `license` | No | string | License name or file reference |
| `compatibility` | No | string | Max 500 chars, environment requirements |
| `metadata` | No | Record\<string, string\> | Arbitrary key-value map |
| `allowed-tools` | No | string | Space-delimited pre-approved tools |

#### Body Content (Instructions)

The markdown body after the frontmatter contains the skill's **instructions**: the content injected into an agent's context when the skill is activated. The spec recommends keeping SKILL.md under 500 lines and 5000 tokens.

#### Optional Directories

- **`references/`**: Additional documentation files (always markdown). Focused reference material that agents load on demand.
- **`scripts/`**: Executable code (Python, Bash, JavaScript). Self-contained with documented dependencies.
- **`assets/`**: Static resources: templates (JSON, YAML), images (PNG, SVG), data files (CSV, schemas). May contain binary files.

### Progressive Disclosure (How Runtimes Load Skills)

| Tier | What's Loaded | When | Token Cost |
|---|---|---|---|
| 1. Catalog | name + description | Session start | ~50-100 tokens/skill |
| 2. Instructions | Full SKILL.md body | Skill activated | <5000 tokens |
| 3. Resources | references/, scripts/, assets/ | On demand | Varies |

Activation is consumer-defined. The spec defines the package format, not how skills get activated. Each runtime (Codex, Claude Code, OpenCode, or our own apps) decides where to scan, how to activate, and what to inject.

### Key Insight

All agent runtimes expect filesystem folders as the interchange format. But no runtime requires folders as the only representation. We can use any runtime representation internally and serialize to folders when agent compatibility is needed.

### Existing Workspace Infrastructure

The monorepo already has `packages/workspace` providing:
- Yjs CRDT-backed tables (`defineTable`) with schema validation, versioning, and migration
- `.withDocument()` for per-row Y.Doc content (Y.Text collaborative editing, timeline model)
- Works in browser (IndexedDB) and server (filesystem)
- Sync between contexts via Yjs providers
- Observation/reactivity for UI binding

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primary consumer | Epicenter apps (browser, edge, desktop) | Skills are a shared runtime resource, not just agent tooling |
| Runtime representation | Workspace tables (Yjs CRDT) | Works everywhere. Syncs. Already built. Validated. Versioned. |
| Schema mapping | 1:1 with agentskills.io spec | Each frontmatter field → column. Instructions → `.withDocument()`. |
| Skill identity | Nanoid `id` + separate `name` column | Stable FK for child rows. `name` can be renamed without cascading updates. |
| Instructions storage | `.withDocument('instructions')` | Collaborative Y.Text editing in browser. `handle.read()` for string access. |
| Child table FK | Reference `skillId` (nanoid), not `name` | Renaming a skill doesn't break child relationships. |
| References storage | Separate `referencesTable` with `.withDocument('content')` | Markdown docs, collaboratively editable in a rich editor. |
| Scripts/assets storage | Deferred (spec'd but not built in v1) | Only `references/` is used across existing 49 skills. Build when needed. |
| Agent compatibility | One-way export (publish step) | Not bidirectional sync. Export when you want folders updated. |
| Import direction | Filesystem → workspace tables | One-time bootstrap from existing skills on disk |
| Package location | `packages/skills` | Shared across all apps, zero app-specific logic |

### Why "instructions" not "body"

The agentskills.io spec uses "instructions" as the semantic name for the post-frontmatter markdown content:

> **Instructions** (< 5000 tokens recommended): The full SKILL.md body is loaded when the skill is activated

`skill.instructions` is self-documenting. `skill.body` is generic. Body of what? The spec's own language settles it. With `.withDocument('instructions')`, the API reads naturally: `ws.documents.skills.instructions.get(id)`.

### Why separate `id` and `name`

The agentskills.io spec requires `name` to match the parent directory and follow strict slug rules (lowercase, hyphens only, 1-64 chars). This is the skill's public identity. But workspace tables use `id` as the stable primary key for relationships.

Separating them means renaming a skill (changing `name` from `"svelte"` to `"svelte5"`) only updates one row. Child rows in `referencesTable` reference `skillId` (the stable nanoid), so they don't need touching.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  packages/skills                                            │
│                                                              │
│  ┌──────────────────┐  ┌─────────────────────────────────┐  │
│  │  Table Schema     │  │  Parse / Serialize               │  │
│  │                   │  │                                  │  │
│  │  skillsTable      │  │  parseSkillMd(name, content)    │  │
│  │  referencesTable  │  │  serializeSkillMd(skill)        │  │
│  │  (scriptsTable)   │  │  importFromDisk(dir, workspace) │  │
│  │  (assetsTable)    │  │  exportToDisk(workspace, dir)   │  │
│  └────────┬─────────┘  └──────────────┬──────────────────┘  │
│           │                            │                     │
└───────────┼────────────────────────────┼─────────────────────┘
            │                            │
  ┌─────────▼──────────┐       ┌────────▼────────────┐
  │  Apps (primary)     │       │  .agents/skills/     │
  │                     │       │  (publish step)      │
  │  apps/skills        │       │                      │
  │  apps/honeycrisp    │       │  Consumed by:        │
  │  apps/api           │       │  - Codex             │
  │  Cloudflare Workers │       │  - Claude Code       │
  │  any Epicenter app  │       │  - OpenCode          │
  └─────────────────────┘       └────────────────────┘
```

### File Structure → Table Mapping

```
.agents/skills/svelte/             skillsTable row
├── SKILL.md                       ├── id: "abc123" (nanoid)
│   --- (frontmatter)              ├── name: "svelte"
│   name: svelte                   ├── description: "Svelte 5 patterns..."
│   description: Svelte 5...       ├── license: undefined
│   metadata:                      ├── compatibility: undefined
│     author: epicenter            ├── metadata: '{"author":"epicenter"}'
│   ---                            ├── allowedTools: undefined
│   # Svelte Guidelines            ├── updatedAt: 1711800000000
│   ## When to Apply…              └── .withDocument('instructions')
│   ...                                 └── Y.Text: "# Svelte Guidelines\n..."
│
├── references/                    referencesTable rows (skillId: "abc123")
│   ├── component-patterns.md      ├── { id: "def456", skillId: "abc123",
│   │                              │     path: "component-patterns.md",
│   │                              │     .withDocument('content') }
│   └── shadcn-patterns.md        └── { id: "ghi789", skillId: "abc123",
│                                       path: "shadcn-patterns.md",
│                                       .withDocument('content') }
│
├── scripts/                       (scriptsTable: deferred, v2)
│   └── extract.py
│
└── assets/                        (assetsTable: deferred, v2)
    └── template.json
```

### Workspace Table Schema

```typescript
// packages/skills/src/tables.ts

import { defineTable, type InferTableRow } from '@epicenter/workspace'
import { type } from 'arktype'

/**
 * Skills table: one row per skill, 1:1 mapping to SKILL.md.
 *
 * Frontmatter fields map to columns. The markdown instructions live in
 * an attached Y.Doc via `.withDocument('instructions')`, enabling
 * collaborative Y.Text editing in browser-based editors.
 *
 * The `id` is a stable nanoid for FK relationships. The `name` column
 * holds the agentskills.io-compliant slug (lowercase, hyphens, 1-64 chars)
 * and can be renamed without cascading updates to child rows.
 *
 * @example
 * ```typescript
 * // Catalog (tier 1): which skills exist?
 * const catalog = ws.tables.get('skills').getAllValid()
 *   .map(s => ({ name: s.name, description: s.description }))
 *
 * // Activate (tier 2): inject instructions into context
 * const skill = ws.tables.get('skills').find(s => s.name === 'writing-voice')
 * const handle = ws.documents.skills.instructions.get(skill.id)
 * systemPrompt += handle.read()
 *
 * // Editor binding: collaborative Y.Text editing
 * const ytext = handle.asText()
 * editor.bind(ytext)
 * ```
 */
export const skillsTable = defineTable(
  type({
    id: 'string',
    name: 'string',
    description: 'string',
    'license?': 'string | undefined',
    'compatibility?': 'string | undefined',
    'metadata?': 'string | undefined',
    'allowedTools?': 'string | undefined',
    updatedAt: 'number',
    _v: '1',
  }),
).withDocument('instructions', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: Date.now() }),
})
export type Skill = InferTableRow<typeof skillsTable>

/**
 * References table: one row per markdown file in a skill's `references/` directory.
 *
 * References are additional documentation loaded on demand (tier 3 in the
 * progressive disclosure model). Each reference file gets its own Y.Doc
 * via `.withDocument('content')` for collaborative editing.
 *
 * The `path` column stores the filename relative to the `references/` directory
 * (e.g., `"component-patterns.md"`), not the full filesystem path.
 *
 * @example
 * ```typescript
 * // Load all references for a skill
 * const refs = ws.tables.get('references')
 *   .filter(r => r.skillId === skill.id)
 *
 * // Read reference content
 * const handle = ws.documents.references.content.get(ref.id)
 * const markdown = handle.read()
 * ```
 */
export const referencesTable = defineTable(
  type({
    id: 'string',
    skillId: 'string',
    path: 'string',
    updatedAt: 'number',
    _v: '1',
  }),
).withDocument('content', {
  guid: 'id',
  onUpdate: () => ({ updatedAt: Date.now() }),
})
export type Reference = InferTableRow<typeof referencesTable>
```

#### Deferred Tables (v2)

The following tables are spec'd for completeness but not implemented in v1. Only `references/` is used across the existing 49 skills.

```typescript
/**
 * Scripts table: one row per executable file in a skill's `scripts/` directory.
 *
 * Scripts are code files (Python, Bash, JavaScript) that agents can run.
 * Stored as plain text `content` column: no `.withDocument()` needed for v1.
 * Add collaborative code editing later if the skills editor supports it.
 *
 * Deferred: no existing skills use `scripts/`.
 */
export const scriptsTable = defineTable(
  type({
    id: 'string',
    skillId: 'string',
    path: 'string',
    content: 'string',
    _v: '1',
  }),
)
export type Script = InferTableRow<typeof scriptsTable>

/**
 * Assets table: one row per static resource in a skill's `assets/` directory.
 *
 * Assets include templates (JSON, YAML), images (PNG, SVG), and data files
 * (CSV, schemas). Text-only for now: binary files (images) are skipped on
 * import. Add base64 encoding or a binary column type when needed.
 *
 * No `.withDocument()`: assets are static resources, not collaboratively edited.
 *
 * Deferred: no existing skills use `assets/`.
 */
export const assetsTable = defineTable(
  type({
    id: 'string',
    skillId: 'string',
    path: 'string',
    content: 'string',
    _v: '1',
  }),
)
export type Asset = InferTableRow<typeof assetsTable>
```

### How Apps Consume Skills

```typescript
// Any app: browser, server, edge
import { skillsTable, referencesTable } from '@epicenter/skills'
import { createWorkspace } from '@epicenter/workspace'

const ws = createWorkspace({
  id: 'epicenter.skills',
  tables: { skills: skillsTable, references: referencesTable },
})

// Catalog (tier 1): which skills exist?
const catalog = ws.tables.get('skills').getAllValid()
  .map(s => ({ name: s.name, description: s.description }))

// Activate (tier 2): read instructions from document
const skill = ws.tables.get('skills').find(s => s.name === 'writing-voice')
const handle = ws.documents.skills.instructions.get(skill.id)
systemPrompt += handle.read()

// On-demand resources (tier 3): load references
const refs = ws.tables.get('references')
  .filter(r => r.skillId === skill.id)
for (const ref of refs) {
  const refHandle = ws.documents.references.content.get(ref.id)
  systemPrompt += `\n\n## ${ref.path}\n${refHandle.read()}`
}
```

### Parse / Serialize (Pure Functions)

```typescript
// packages/skills/src/parse.ts

import { generateId } from '@epicenter/workspace'

/**
 * Parse a SKILL.md file into fields suitable for a skills table row.
 *
 * Splits YAML frontmatter from the markdown body. Frontmatter fields
 * map 1:1 to table columns. The body becomes the instructions document
 * content (written separately via `handle.writeText()`).
 *
 * @param name - The skill's directory name (becomes the `name` column)
 * @param content - The raw SKILL.md file content
 * @returns Parsed skill metadata and instructions text
 *
 * @example
 * ```typescript
 * const { skill, instructions } = parseSkillMd('svelte', rawContent)
 * ws.tables.get('skills').set(skill)
 * ws.documents.skills.instructions.get(skill.id).writeText(instructions)
 * ```
 */
export function parseSkillMd(name: string, content: string) {
  const { frontmatter, body } = splitFrontmatter(content)
  return {
    skill: {
      id: generateId(),
      name,
      description: frontmatter.description,
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      metadata: frontmatter.metadata
        ? JSON.stringify(frontmatter.metadata)
        : undefined,
      allowedTools: frontmatter['allowed-tools'],
      updatedAt: Date.now(),
      _v: 1 as const,
    },
    instructions: body,
  }
}

/**
 * Serialize a skill back to SKILL.md format for agentskills.io export.
 *
 * Reconstructs YAML frontmatter from table columns and appends the
 * instructions markdown. Only includes non-undefined optional fields
 * in the frontmatter to keep exported files clean.
 *
 * @param skill - The skill row from the table
 * @param instructions - The instructions text from the document
 * @returns A valid SKILL.md file string
 *
 * @example
 * ```typescript
 * const handle = ws.documents.skills.instructions.get(skill.id)
 * const md = serializeSkillMd(skill, handle.read())
 * await writeFile(`${dir}/${skill.name}/SKILL.md`, md)
 * ```
 */
export function serializeSkillMd(skill: Skill, instructions: string): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  }
  if (skill.license) fm.license = skill.license
  if (skill.compatibility) fm.compatibility = skill.compatibility
  if (skill.metadata) fm.metadata = JSON.parse(skill.metadata)
  if (skill.allowedTools) fm['allowed-tools'] = skill.allowedTools

  return `---\n${yaml.stringify(fm)}---\n\n${instructions}`
}
```

### Import / Export (Server Only)

```
IMPORT (one-time bootstrap, disk → workspace):
  1. Scan .agents/skills/ for folders containing SKILL.md
  2. For each folder:
     a. parseSkillMd(folderName, fileContent) → { skill, instructions }
     b. Upsert skill row into skillsTable
     c. Write instructions to skill's document via handle.writeText()
     d. Enumerate references/*.md files → referencesTable rows + documents
  3. Skip scripts/ and assets/ directories (deferred to v2)

EXPORT (publish step, workspace → disk):
  1. Read all skill rows from workspace
  2. For each skill:
     a. Read instructions via handle.read()
     b. serializeSkillMd(skill, instructions) → write to {name}/SKILL.md
     c. For each reference matching this skillId:
        Read content via handle.read() → write to {name}/references/{path}
  3. Remove folders for skills that no longer exist in workspace
```

Export is a one-way publish step, not a bidirectional sync. Run it when you want to update the `.agents/skills/` folders for agent consumption.

## Implementation Plan

### Phase 1: Package + Schema

- [ ] **1.1** Create `packages/skills/` with package.json, tsconfig.json, src/index.ts
- [ ] **1.2** `src/tables.ts`: `skillsTable` and `referencesTable` with full JSDoc (see schema section above). Include `scriptsTable` and `assetsTable` as commented-out deferred definitions.
- [ ] **1.3** `src/types.ts`: `Skill`, `Reference`, `Script`, `Asset` type exports. JSDoc explaining the 1:1 mapping to agentskills.io spec fields.
- [ ] **1.4** `src/parse.ts`: `parseSkillMd(name, content)` with JSDoc, `@example`, and explanation of frontmatter → column mapping. Include `splitFrontmatter()` helper.
- [ ] **1.5** `src/serialize.ts`: `serializeSkillMd(skill, instructions)` with JSDoc, `@example`, and explanation of which optional fields are included/omitted.

### Phase 2: Import / Export

- [ ] **2.1** `src/import.ts`: `importFromDisk(dir, workspace)` with JSDoc. Scans `.agents/skills/`, parses SKILL.md files, upserts skill rows, writes instruction documents, enumerates `references/` files into `referencesTable` with documents. Skips `scripts/` and `assets/`.
- [ ] **2.2** `src/export.ts`: `exportToDisk(workspace, dir)` with JSDoc. Reads all skills, serializes to SKILL.md, writes reference files, cleans up deleted skill folders.
- [ ] **2.3** Verify round-trip: import 49 existing skills → export → diff shows only expected changes (nanoid in row, formatting normalization).

### Phase 3: Integration

- [ ] **3.1** Wire into skills editor app (`apps/skills/`): replace virtual filesystem with workspace tables.
- [ ] **3.2** Add skills loading to one existing app as proof-of-concept (e.g., `apps/honeycrisp` or `apps/api`).

### Phase 4: Read Actions (Isomorphic)

Add query actions to the isomorphic `createSkillsWorkspace()` so any app can consume skills without touching tables directly. These follow the agentskills.io progressive disclosure model (Catalog → Instructions → Resources) and use `defineQuery` from `@epicenter/workspace`.

The agentskills.io spec is purely a file-format standard. It defines no consumption API. The `skills-ref` Python CLI provides `read_properties` and `to_prompt` as the only official programmatic surface. Our read actions are the TypeScript equivalent, designed for workspace-native consumption.

#### Actions

| Action | Tier | Docs Opened | Returns |
|---|---|---|---|
| `listSkills()` | 1 (Catalog) | 0 | `{ id, name, description }[]` |
| `getSkill({ id })` | 2 (Instructions) | 1 | `{ skill, instructions }` |
| `getSkillWithReferences({ id })` | 3 (Resources) | 1 + N | `{ skill, instructions, references[] }` |

#### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Actions vs raw table access | Actions | Assembly logic (skill row + instructions doc + references) is domain logic that belongs in the package, not reimplemented by each consumer |
| `getSkill` returns metadata + instructions | Combined | Callers almost always want both. `getSkill(id).instructions` is fine when you only want one |
| `getSkillWithReferences` vs `getSkillBundle` | `WithReferences` | "Bundle" is invented terminology. "WithReferences" says exactly what extra data you get. When scripts/assets are added, we can expand or add `getSkillWithResources` |
| Input as `{ id }` object vs plain string | `{ id }` object | `defineQuery` input must be a Standard Schema object for MCP/OpenAPI compatibility |
| Actions on isomorphic workspace | Yes | Read actions don't need Node fs or browser APIs. They only read tables and documents. Belongs in `workspace.ts`, not `node.ts` |
| `listSkills` has no input | Correct | Returns all skills. Filtering is the consumer's job |

#### Implementation

```typescript
// packages/skills/src/workspace.ts
import { createWorkspace, defineQuery } from '@epicenter/workspace';
import { type } from 'arktype';
import { skillsDefinition } from './definition.js';

export function createSkillsWorkspace() {
  return createWorkspace(skillsDefinition).withActions((client) => ({
    /**
     * List all skills as lightweight catalog entries.
     *
     * Returns id, name, and description for every valid skill row.
     * No documents are opened. This is cheap enough to call on every
     * render cycle or at agent session startup.
     *
     * Mirrors tier 1 (Catalog) of the agentskills.io progressive
     * disclosure model: ~50-100 tokens per skill.
     */
    listSkills: defineQuery({
      description: 'List all skills (id, name, description)',
      handler: () =>
        client.tables.skills
          .getAllValid()
          .map((s) => ({ id: s.id, name: s.name, description: s.description }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    }),

    /**
     * Get a single skill's metadata and instructions.
     *
     * Opens the skill's instructions document (one Y.Doc) and reads
     * the full markdown content. Returns the skill row alongside the
     * instructions text. Callers almost always need both.
     *
     * Mirrors tier 2 (Instructions) of the agentskills.io progressive
     * disclosure model: <5000 tokens recommended.
     */
    getSkill: defineQuery({
      description: 'Get skill metadata and instructions by ID',
      input: type({ id: 'string' }),
      handler: async ({ id }) => {
        const skill = client.tables.skills.find((s) => s.id === id);
        if (!skill) return null;
        const handle = await client.documents.skills.instructions.open(id);
        return { skill, instructions: handle.read() };
      },
    }),

    /**
     * Get a skill with its full instructions and all reference content.
     *
     * Opens the instructions document plus one content document per
     * reference. Expensive for skills with many references. Use this
     * at agent prompt assembly time when the full skill context is
     * needed, not for catalog browsing.
     *
     * Mirrors tier 3 (Resources) of the agentskills.io progressive
     * disclosure model.
     */
    getSkillWithReferences: defineQuery({
      description: 'Get skill with instructions and all reference content',
      input: type({ id: 'string' }),
      handler: async ({ id }) => {
        const skill = client.tables.skills.find((s) => s.id === id);
        if (!skill) return null;
        const instructionsHandle = await client.documents.skills.instructions.open(id);
        const refs = client.tables.references.filter((r) => r.skillId === id);
        const references = await Promise.all(
          refs.map(async (ref) => {
            const contentHandle = await client.documents.references.content.open(ref.id);
            return { path: ref.path, content: contentHandle.read() };
          }),
        );
        return {
          skill,
          instructions: instructionsHandle.read(),
          references: references.sort((a, b) => a.path.localeCompare(b.path)),
        };
      },
    }),
  }));
}
```

#### Consuming App Example

```typescript
// Any app. Browser, server, edge
import { createSkillsWorkspace } from '@epicenter/skills'

const ws = createSkillsWorkspace()
  .withExtension('persistence', indexeddbPersistence)

// Tier 1. Catalog for a skill picker
const skills = ws.actions.listSkills()

// Tier 2. Inject into agent context
const result = await ws.actions.getSkill({ id: 'abc123' })
if (result) systemPrompt += result.instructions

// Tier 3. Full skill with references for deep agent context
const full = await ws.actions.getSkillWithReferences({ id: 'abc123' })
if (full) {
  systemPrompt += full.instructions
  for (const ref of full.references) {
    systemPrompt += `\n\n## ${ref.path}\n${ref.content}`
  }
}
```

#### Tasks

- [x] **4.1** Add read actions (`listSkills`, `getSkill`, `getSkillWithReferences`) to `packages/skills/src/workspace.ts` via `.withActions()`
- [x] **4.2** Re-export `defineQuery` usage. Ensure `workspace.ts` imports `defineQuery` from `@epicenter/workspace` and input schema from `typebox` (TypeBox used instead of arktype for `defineQuery` TypeBox `Static<>` inference compatibility)
- [x] **4.3** Update `packages/skills/src/index.ts` barrel if any new types need exporting: no new types needed (return types inferred from handlers)
- [ ] **4.4** Verify actions work: write a test or script that calls all three actions after `importFromDisk`
- [x] **4.5** Run `bun typecheck` on `packages/skills` to confirm no type errors

## Edge Cases

### Skill renamed in editor

1. User renames skill `"svelte"` to `"svelte5"` by changing the `name` column
2. The `id` (nanoid) stays the same: all references in `referencesTable` are unaffected
3. On export, a new folder `svelte5/` is created; old `svelte/` folder still exists on disk
4. Export should delete `svelte/`: or flag it for user confirmation

### Re-importing after edits

1. Skills are imported (assigned nanoids), then edited in the browser
2. User re-imports from disk (e.g., after editing SKILL.md in a text editor)
3. Import should match by `name`, not `id`: update existing rows rather than creating duplicates
4. Instructions document is overwritten with the new file content

### Skill with binary assets (deferred)

1. Skill has `assets/logo.png` (binary file)
2. `assetsTable` stores `content: string`: can't hold binary
3. Skip binary files on import for now. Add base64 encoding or binary column type in v2.

## Open Questions

1. **Should export be automatic or manual?**
   - **Recommendation**: Manual (CLI command or button). Skills change slowly; automatic sync adds complexity for no real benefit.

2. **Should the workspace be shared across apps or per-app?**
   - **Recommendation**: Single shared workspace (`epicenter.skills`). All apps see the same skills. Yjs sync keeps them consistent.

3. **Should we keep the virtual filesystem in the skills editor or replace it?**
   - **Recommendation**: Replace. The virtual FS was a placeholder. Workspace tables give us sync and structured editing without reimplementing fs semantics.

## Success Criteria

- [ ] `packages/skills` exists with table definitions, types, and parse/serialize functions
- [ ] All public functions and types have JSDoc with `@example` blocks
- [ ] Can import all 49 existing skills from `.agents/skills/` into workspace tables
- [ ] Can export skills back to valid agentskills.io-compliant folders
- [ ] At least one app in `apps/` consumes skills via `@epicenter/skills`

## References

- [agentskills.io/specification](https://agentskills.io/specification): Canonical skill format spec
- [agentskills.io/client-implementation](https://agentskills.io/client-implementation/adding-skills-support): How runtimes load skills
- `.agents/skills/`: Existing 49 skills in this repo
- `packages/workspace/`: Yjs CRDT table infrastructure
- `apps/skills/`: Draft skills editor (PR #1556, branch `opencode/eager-garden`)
- `specs/20260319T120000-skill-authoring-model.md`: Previous skill restructuring spec
