/**
 * @fileoverview Workspace table definitions for agent skills.
 *
 * Maps the [agentskills.io](https://agentskills.io/specification) skill
 * package format to Yjs CRDT-backed tables. Each frontmatter field becomes
 * a column; the markdown instruction body lives in a per-row Y.Doc opened
 * through the app-owned `instructionsDocs` factory.
 *
 * @module
 */

import { defineTable, nullable, type InferTableRow } from '@epicenter/workspace';
import { field } from '@epicenter/field';

/**
 * Skills table, one row per skill, 1:1 mapping to SKILL.md.
 *
 * Frontmatter fields map to columns. The markdown instructions live in a
 * per-row Y.Doc opened through the `instructionsDocs` factory, enabling
 * collaborative Y.Text editing in browser-based editors.
 *
 * The `id` is a stable nanoid for FK relationships. The `name` column
 * holds the agentskills.io-compliant slug (lowercase, hyphens, 1-64 chars)
 * and can be renamed without cascading updates to child rows.
 *
 * Optional frontmatter fields (`license`, `compatibility`, `metadata`,
 * `allowedTools`) are stored as nullable columns: `null` means "not set".
 *
 * @example
 * ```typescript
 * // Catalog (tier 1), which skills exist?
 * const catalog = ws.tables.skills.getAllValid()
 *   .map(s => ({ name: s.name, description: s.description }))
 *
 * // Activate (tier 2), inject instructions into context
 * const skill = ws.tables.skills.find(s => s.name === 'writing-voice')
 * if (skill) {
 *   using h = instructionsDocs.open(skill.id)
 *   await h.whenReady
 *   systemPrompt += h.instructions.read()
 * }
 *
 * // Editor binding, collaborative Y.Text editing
 * const handle = instructionsDocs.open(skill.id)
 * editor.bind(handle.instructions.binding)
 * // ...on unmount: handle[Symbol.dispose]()
 * ```
 */
export const skillsTable = defineTable({
	id: field.string(),
	name: field.string(),
	description: field.string(),
	license: nullable(field.string()),
	compatibility: nullable(field.string()),
	metadata: nullable(field.string()),
	allowedTools: nullable(field.string()),
	updatedAt: field.number(),
});

/**
 * References table, one row per markdown file in a skill's `references/` directory.
 *
 * References are additional documentation loaded on demand (tier 3 in the
 * progressive disclosure model). Each reference file gets its own Y.Doc
 * opened through the `referenceDocs` factory for collaborative editing.
 *
 * The `path` column stores the filename relative to the `references/` directory
 * (e.g., `"component-patterns.md"`), not the full filesystem path.
 *
 * @example
 * ```typescript
 * // Load all references for a skill
 * const refs = ws.tables.references.filter(r => r.skillId === skill.id)
 *
 * // Read reference content
 * for (const ref of refs) {
 *   using h = referenceDocs.open(ref.id)
 *   await h.whenReady
 *   const markdown = h.content.read()
 * }
 * ```
 */
export const referencesTable = defineTable({
	id: field.string(),
	skillId: field.string(),
	path: field.string(),
	updatedAt: field.number(),
});

export type Skill = InferTableRow<typeof skillsTable>;
export type Reference = InferTableRow<typeof referencesTable>;
