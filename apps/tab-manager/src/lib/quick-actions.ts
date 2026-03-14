/**
 * Quick action registry for the command palette.
 *
 * Each action has a label, description, icon, and execute function.
 * Dangerous actions show a confirmation dialog before executing.
 * Actions read from {@link browserState} and call Chrome APIs.
 *
 * @example
 * ```typescript
 * import { quickActions } from '$lib/quick-actions';
 *
 * for (const action of quickActions) {
 *   console.log(action.label, action.description);
 * }
 * ```
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import CopyMinusIcon from '@lucide/svelte/icons/copy-minus';
import GroupIcon from '@lucide/svelte/icons/group';
import type { Component } from 'svelte';
import { Ok, tryAsync } from 'wellcrafted/result';
import { browserState } from '$lib/state/browser-state.svelte';
import { findDuplicateGroups, groupTabsByDomain } from '$lib/utils/tab-helpers';
import type { TabCompositeId } from '$lib/workspace';
import { parseTabId } from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QuickAction = {
	id: string;
	label: string;
	description: string;
	icon: Component;
	keywords: string[];
	execute: () => Promise<void> | void;
	/** When true, execute shows a confirmation dialog before running. */
	dangerous?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Batch-resolve composite tab IDs to native Chrome tab IDs.
 */
function compositeToNativeIds(compositeIds: TabCompositeId[]): number[] {
	return compositeIds
		.map((id) => parseTabId(id)?.tabId)
		.filter((id) => id !== undefined);
}

/**
 * Get all tabs across all windows as a flat array.
 */
function getAllTabs() {
	return browserState.windows.flatMap((w) => browserState.tabsByWindow(w.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

const dedupAction: QuickAction = {
	id: 'dedup',
	label: 'Remove Duplicates',
	description: 'Close duplicate tabs with the same URL',
	icon: CopyMinusIcon,
	keywords: ['dedup', 'duplicate', 'remove', 'close', 'clean'],
	dangerous: true,
	execute() {
		const dupes = findDuplicateGroups(getAllTabs());
		if (dupes.size === 0) return;

		const totalDuplicates = [...dupes.values()].reduce(
			(sum, group) => sum + group.length - 1,
			0,
		);

		const toClose = [...dupes.values()].flatMap((group) =>
			group.slice(1).map((t) => t.id as TabCompositeId),
		);

		confirmationDialog.open({
			title: 'Remove Duplicate Tabs',
			description: `Found ${totalDuplicates} duplicate tab${totalDuplicates === 1 ? '' : 's'} across ${dupes.size} URL${dupes.size === 1 ? '' : 's'}. Close them?`,
			confirm: { text: 'Close Duplicates', variant: 'destructive' },
			async onConfirm() {
				const nativeIds = compositeToNativeIds(toClose);
				await tryAsync({
					try: () => browser.tabs.remove(nativeIds),
					catch: () => Ok(undefined),
				});
			},
		});
	},
};

const groupByDomainAction: QuickAction = {
	id: 'group-by-domain',
	label: 'Group Tabs by Domain',
	description: 'Create tab groups based on website domain',
	icon: GroupIcon,
	keywords: ['group', 'domain', 'organize', 'categorize'],
	async execute() {
		const allTabs = getAllTabs();
		const domains = groupTabsByDomain(allTabs);

		const groupOps = [...domains.entries()]
			.filter(([, tabs]) => tabs.length >= 2)
			.map(([domain, tabs]) => {
				const nativeIds = compositeToNativeIds(
					tabs.map((t) => t.id as TabCompositeId),
				);
				return nativeIds.length >= 2 ? { domain, nativeIds } : null;
			})
			.filter((op) => op !== null);

		await Promise.allSettled(
			groupOps.map(async ({ domain, nativeIds }) => {
				const groupId = await browser.tabs.group({
					tabIds: nativeIds as [number, ...number[]],
				});
				await browser.tabGroups.update(groupId, { title: domain });
			}),
		);
	},
};

/**
 * All registered quick actions for the command palette.
 *
 * Actions are ordered by expected frequency of use.
 */
export const quickActions: QuickAction[] = [dedupAction, groupByDomainAction];
