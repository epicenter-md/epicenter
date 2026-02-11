/**
 * Node.js entry point for workspace definition utilities.
 *
 * This module re-exports workspace definition helpers for Node.js environments.
 * For creating workspace clients, use `createWorkspace` from `@epicenter/hq/dynamic`.
 *
 * @example
 * ```typescript
 * import { defineWorkspace, id, text, table } from '@epicenter/hq/node';
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 *
 * const definition = defineWorkspace({
 *   name: 'Blog',
 *   tables: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] }),
 *   ],
 *   kv: [],
 * });
 *
 * // Use createWorkspace to create workspace clients
 * const workspace = createWorkspace(definition).withExtensions({ persistence });
 * ```
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-export field schema factories for defining workspace tables.
 *
 * These are the building blocks for table definitions:
 *
 * ```typescript
 * import { defineWorkspace, id, text, boolean, date, table } from '@epicenter/hq/node';
 *
 * const definition = defineWorkspace({
 *   name: 'Blog',
 *   tables: [
 *     table({
 *       id: 'posts',
 *       name: 'Posts',
 *       fields: [
 *         id(),           // Primary key (always required)
 *         text({ id: 'title' }),  // NOT NULL text
 *         boolean({ id: 'published', default: false }),
 *         date({ id: 'createdAt' }),  // Temporal-aware date with timezone
 *       ],
 *     }),
 *   ],
 *   kv: [],
 * });
 * ```
 *
 * @see {@link ../schema/fields/factories.ts} - Field factory implementations
 * @see {@link ../schema/fields/types.ts} - Field type definitions
 */
export {
	// Field factories for table definitions
	boolean,
	// Icon utilities
	createIcon,
	date,
	// ID generation utilities
	generateGuid,
	generateId,
	id,
	integer,
	isIcon,
	json,
	parseIcon,
	real,
	select,
	table,
	tags,
	text,
} from '../schema';

/**
 * Re-export types from workspace.ts for consumers of the Node entrypoint.
 *
 * @see {@link ./workspace.ts} - Where these types are defined
 */
export type { WorkspaceDefinition } from './workspace';

/**
 * Re-export defineWorkspace from workspace.ts.
 *
 * `defineWorkspace` applies defaults for optional fields:
 * - `description` defaults to empty string
 * - `icon` defaults to null
 */
export { defineWorkspace } from './workspace';
