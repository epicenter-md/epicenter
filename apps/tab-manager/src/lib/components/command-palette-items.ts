/**
 * Command palette items for the tab manager.
 *
 * Each item has a label, description, icon, and `onSelect` handler.
 * Some items open a confirmation dialog before executing—they manage
 * this internally so the confirmation message can include runtime context
 * (e.g. "Found 5 duplicates across 3 URLs").
 *
 * @example
 * ```typescript
 * import { items } from './items';
 *
 * for (const item of items) {
 *   console.log(item.label, item.description);
 * }
 * ```
 */

import type { CommandPaletteItem } from '@epicenter/ui/command-palette';
import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toastOnError } from '@epicenter/ui/sonner';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import ArrowDownAZIcon from '@lucide/svelte/icons/arrow-down-a-z';
import CopyMinusIcon from '@lucide/svelte/icons/copy-minus';
import GlobeIcon from '@lucide/svelte/icons/globe';
import GroupIcon from '@lucide/svelte/icons/group';
import { Ok, tryAsync } from 'wellcrafted/result';
import { browserState } from '$lib/state/browser-state.svelte';
import { savedTabState } from '$lib/state/saved-tab-state.svelte';
import { findDuplicateGroups, groupTabsByDomain } from '$lib/utils/tab-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all tabs across all windows as a flat array.
 */
function getAllTabs() {
	return browserState.windows.flatMap((w) => browserState.tabsByWindow(w.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All command palette items for the tab manager.
 *
 * Ordered by expected frequency of use.
 */
export const items: CommandPaletteItem[] = [
	{
		id: 'dedup',
		label: 'Remove Duplicates',
		description: 'Close duplicate tabs with the same URL',
		icon: CopyMinusIcon,
		keywords: ['dedup', 'duplicate', 'remove', 'close', 'clean'],
		group: 'Quick Actions',
		onSelect() {
			const allTabs = getAllTabs();
			const dupes = findDuplicateGroups(allTabs);
			if (dupes.size === 0) return;

			const totalDuplicates = [...dupes.values()].reduce(
				(sum, group) => sum + group.length - 1,
				0,
			);

			const toClose = [...dupes.values()].flatMap((group) =>
				group.slice(1).map((t) => t.id),
			);

			const pct = Math.round((toClose.length / allTabs.length) * 100);
			const dangerousRatio = pct > 25;

			confirmationDialog.open({
				title: 'Remove Duplicate Tabs',
				description: `Found ${totalDuplicates} duplicate tab${totalDuplicates === 1 ? '' : 's'} out of ${allTabs.length} total across ${dupes.size} URL${dupes.size === 1 ? '' : 's'}. Close them?`,
				confirm: { text: 'Close Duplicates', variant: 'destructive' },
				...(dangerousRatio && {
					input: { confirmationText: String(totalDuplicates) },
				}),
				async onConfirm() {
					await tryAsync({
						try: () => browser.tabs.remove(toClose),
						catch: () => Ok(undefined),
					});
				},
			});
		},
	},
	{
		id: 'group-by-domain',
		label: 'Group Tabs by Domain',
		description: 'Create tab groups based on website domain',
		icon: GroupIcon,
		keywords: ['group', 'domain', 'organize', 'categorize'],
		group: 'Quick Actions',
		async onSelect() {
			const allTabs = getAllTabs();
			const domains = groupTabsByDomain(allTabs);

			const groupOps = [...domains.entries()]
				.filter(([, tabs]) => tabs.length >= 2)
				.map(([domain, tabs]) => {
					const nativeIds = tabs.map((t) => t.id);
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
	},
	{
		id: 'sort',
		label: 'Sort Tabs by Title',
		description: 'Sort tabs alphabetically within each window',
		icon: ArrowDownAZIcon,
		keywords: ['sort', 'alphabetical', 'order', 'organize'],
		group: 'Quick Actions',
		async onSelect() {
			for (const window of browserState.windows) {
				const tabs = browserState.tabsByWindow(window.id);
				const sorted = [...tabs].sort((a, b) =>
					(a.title ?? '').localeCompare(b.title ?? ''),
				);

				for (let i = 0; i < sorted.length; i++) {
					const tab = sorted[i];
					if (!tab) continue;
					await tryAsync({
						try: () => browser.tabs.move(tab.id, { index: i }),
						catch: () => Ok(undefined),
					});
				}
			}
		},
	},
	{
		id: 'close-by-domain',
		label: 'Close Tabs by Domain',
		description: 'Close all tabs from a specific domain',
		icon: GlobeIcon,
		keywords: ['close', 'domain', 'website', 'remove'],
		group: 'Quick Actions',
		onSelect() {
			const domains = groupTabsByDomain(getAllTabs());
			if (domains.size === 0) return;

			let topDomain = '';
			let topCount = 0;
			for (const [domain, tabs] of domains) {
				if (tabs.length > topCount) {
					topDomain = domain;
					topCount = tabs.length;
				}
			}

			const tabIds = (domains.get(topDomain) ?? []).map((t) => t.id);

			confirmationDialog.open({
				title: `Close ${topDomain} Tabs`,
				description: `Close ${topCount} tab${topCount === 1 ? '' : 's'} from ${topDomain}?`,
				confirm: { text: 'Close Tabs', variant: 'destructive' },
				async onConfirm() {
					await tryAsync({
						try: () => browser.tabs.remove(tabIds),
						catch: () => Ok(undefined),
					});
				},
			});
		},
	},
	{
		id: 'save-all',
		label: 'Save All Tabs',
		description: 'Save all open tabs for later and close them',
		icon: ArchiveIcon,
		keywords: ['save', 'all', 'close', 'stash', 'park'],
		group: 'Quick Actions',
		onSelect() {
			const allTabs = getAllTabs();
			if (allTabs.length === 0) return;

			confirmationDialog.open({
				title: 'Save All Tabs',
				description: `Save and close ${allTabs.length} tab${allTabs.length === 1 ? '' : 's'}?`,
				confirm: { text: 'Save & Close All', variant: 'destructive' },
				async onConfirm() {
					const tabsWithUrls = allTabs.filter((tab) => tab.url);
					await Promise.allSettled(
						tabsWithUrls.map((tab) =>
							savedTabState.save(tab).then(toastOnError),
						),
					);
				},
			});
		},
	},
];
