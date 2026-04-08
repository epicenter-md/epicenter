/**
 * Reactive tool trust state backed by the workspace's toolTrust table.
 *
 * Mutation tools start as 'ask' (show approval UI in chat).
 * When a user clicks "Always Allow", the tool is set to 'always'
 * and future invocations auto-approve without prompting.
 *
 * Trust state syncs across devices via the workspace's Y.Doc CRDT.
 * Query tools never consult this module—they auto-execute always.
 *
 * @module
 */

import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';
import type { ToolTrust } from '$lib/workspace';

/**
 * Trust level for a mutation tool.
 *
 * - `'ask'` — show inline approval UI ([Allow] / [Always Allow] / [Deny])
 * - `'always'` — auto-approve immediately, show subtle indicator
 */
export type TrustLevel = ToolTrust['trust'];

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

function createToolTrustState() {
	const trustMap = fromTable(workspace.tables.toolTrust);

	/** Cached projection of trust entries — stable reference via $derived. */
	const trustEntries = $derived(
		trustMap
			.values()
			.toArray()
			.map((t): [string, TrustLevel] => [t.id, t.trust]),
	);
	return {
		/**
		 * Get the trust level for a tool.
		 *
		 * Returns `'ask'` for tools not in the trust table (the safe default).
		 * Query tools should not call this—they auto-execute always.
		 *
		 * @example
		 * ```typescript
		 * if (toolTrustState.get('tabs_close') === 'always') {
		 *   client.approve(toolCallId);
		 * }
		 * ```
		 */
		get(name: string): TrustLevel {
			return trustMap.get(name)?.trust ?? 'ask';
		},

		/**
		 * Set the trust level for a tool.
		 *
		 * Writes to the workspace table (Y.Doc-backed), which triggers
		 * the observer to update the internal trust map reactively. Syncs
		 * across devices via CRDT.
		 *
		 * @example
		 * ```typescript
		 * // User clicks "Always Allow" on the approval UI
		 * toolTrustState.set('tabs_close', 'always');
		 * client.approve(toolCallId);
		 * ```
		 */
		set(name: string, level: TrustLevel): void {
			workspace.tables.toolTrust.set({
				id: name,
				trust: level,
				_v: 1,
			});
		},

		/**
		 * Check if a tool should auto-approve without showing the approval UI.
		 *
		 * Convenience wrapper around `toolTrustState.get(name) === 'always'`.
		 *
		 * @example
		 * ```typescript
		 * if (toolTrustState.shouldAutoApprove(part.name)) {
		 *   client.approve(part.toolCallId);
		 * } else {
		 *   // Show [Allow] / [Always Allow] / [Deny] buttons
		 * }
		 * ```
		 */
		shouldAutoApprove(name: string): boolean {
			return (trustMap.get(name)?.trust ?? 'ask') === 'always';
		},

		/**
		 * All trust entries as a cached reactive array.
		 *
		 * Returns `[toolName, trustLevel]` tuples. Stable reference via `$derived`—
		 * recomputes only when the underlying trustMap changes.
		 *
		 * @example
		 * ```typescript
		 * const trusted = $derived(
		 *   toolTrustState.entries.filter(([, level]) => level === 'always'),
		 * );
		 * ```
		 */
		get entries(): [string, TrustLevel][] {
			return trustEntries;
		},
	};
}

export const toolTrustState = createToolTrustState();
