/**
 * @fileoverview Isomorphic workspace tables and factory for agent skills.
 *
 * This entry point is safe to import in any runtime (browser, Node, Bun).
 * For server-side disk I/O actions, use `@epicenter/skills/node` instead.
 *
 * @example Browser — tables only
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 *
 * @example Server — with disk I/O
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/node'
 *
 * const ws = createSkillsWorkspace()
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * ```
 *
 * @module
 */

export { skillsDefinition } from './definition.js';
export type { Reference, Skill } from './tables.js';

// Tables + types (for embedding in custom workspaces)
export { referencesTable, skillsTable } from './tables.js';
// Workspace factory + definition
export { createSkillsWorkspace } from './workspace.js';
