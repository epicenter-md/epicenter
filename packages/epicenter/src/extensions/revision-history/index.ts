/**
 * Revision History Extension
 *
 * Stores Y.Snapshots for time-travel and revision history.
 * Currently only supports local filesystem storage.
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { localRevisionHistory } from '@epicenter/hq/extensions/revision-history';
 *
 * const workspace = createWorkspace({ name: 'Blog', tables: {...} })
 *   .withExtensions({
 *     revisions: (ctx) => localRevisionHistory(ctx, {
 *       directory: './workspaces',
 *       maxVersions: 50,
 *     }),
 *   });
 *
 * // Save manually (bypasses debounce)
 * workspace.extensions.revisions.save('Before refactor');
 *
 * // List versions
 * const versions = await workspace.extensions.revisions.list();
 *
 * // View historical state (read-only)
 * const oldDoc = await workspace.extensions.revisions.view(5);
 *
 * // Restore to a version
 * await workspace.extensions.revisions.restore(5);
 * ```
 */
export {
	type LocalRevisionHistoryConfig,
	localRevisionHistory,
	type VersionEntry,
} from './local.js';
