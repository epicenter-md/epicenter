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

import { SvelteMap } from 'svelte/reactivity';
import { type ToolTrust, workspaceClient } from '$lib/workspace';

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
	/** Build the trust map from the workspace table. */
	function readAllTrust(): Map<string, TrustLevel> {
		const entries = workspaceClient.tables.toolTrust.getAllValid();
		return new Map(entries.map((row) => [row.id, row.trust]));
	}

	/** Internal reactive map — hidden from consumers. */
	const trustMap = new SvelteMap<string, TrustLevel>(readAllTrust());

	// Keep reactive state in sync with Y.Doc changes (local + remote)
	workspaceClient.tables.toolTrust.observe(() => {
		const fresh = readAllTrust();
		// Clear and repopulate to trigger Svelte reactivity
		trustMap.clear();
		for (const [key, value] of fresh) {
			trustMap.set(key, value);
		}
	});

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
			return trustMap.get(name) ?? 'ask';
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
			workspaceClient.tables.toolTrust.set({
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
			return (trustMap.get(name) ?? 'ask') === 'always';
		},

		/**
		 * All trust entries as a reactive map.
		 *
		 * Returns the internal `SvelteMap` directly. Consumers get live
		 * updates when trust changes (local or remote via Y.Doc sync).
		 * Filter for `'always'` entries to show only explicitly trusted tools.
		 *
		 * @example
		 * ```typescript
		 * const trusted = $derived(
		 *   [...toolTrustState.entries()]
		 *     .filter(([, level]) => level === 'always'),
		 * );
		 * ```
		 */
		entries(): SvelteMap<string, TrustLevel> {
			return trustMap;
		},
	};
}

export const toolTrustState = createToolTrustState();
