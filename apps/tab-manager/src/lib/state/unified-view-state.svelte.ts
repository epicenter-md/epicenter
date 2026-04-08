/**
 * Reactive unified view state for the side panel.
 *
 * Manages section expansion (open tabs, saved for later, bookmarks) and
 * derives a single flat item array from {@link browserState},
 * {@link savedTabState}, and {@link bookmarkState}. The flat array feeds
 * a single VList that renders all sections in one scrollable view.
 *
 * Section expand/collapse works identically to how window expand/collapse
 * already works in the original `FlatTabList`—a `SvelteSet` tracks expanded
 * sections, and `$derived` flatItems includes or excludes child items.
 *
 * @example
 * ```svelte
 * <script>
 *   import { unifiedViewState } from '$lib/state/unified-view-state.svelte';
 * </script>
 *
 * <VList data={unifiedViewState.flatItems}>
 *   {#snippet children(item)}
 *     {#if item.kind === 'section-header'}...{/if}
 *   {/snippet}
 * </VList>
 * ```
 */

import { SvelteSet } from 'svelte/reactivity';
import { bookmarkState } from '$lib/state/bookmark-state.svelte';
import type {
	BrowserTab,
	BrowserWindow,
} from '$lib/state/browser-state.svelte';
import { browserState } from '$lib/state/browser-state.svelte';
import { savedTabState } from '$lib/state/saved-tab-state.svelte';
import {
	searchCaseSensitive,
	searchExactMatch,
	searchField,
	searchRegex,
} from '$lib/state/search-preferences.svelte';
import { normalizeUrl } from '$lib/utils/tab-helpers';
import type { Bookmark, SavedTab } from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SectionId = 'open-tabs' | 'saved' | 'bookmarks';

export type FlatItem =
	| { kind: 'section-header'; section: SectionId; label: string; count: number }
	| { kind: 'window-header'; window: BrowserWindow }
	| { kind: 'tab'; tab: BrowserTab }
	| { kind: 'saved-tab'; savedTab: SavedTab }
	| { kind: 'bookmark'; bookmark: Bookmark };

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

function createUnifiedViewState() {
	/** Which top-level sections are expanded. All expanded by default. */
	const expandedSections = new SvelteSet<SectionId>([
		'open-tabs',
		'saved',
		'bookmarks',
	]);

	/**
	 * Which windows are expanded within the open tabs section.
	 *
	 * Starts empty because this singleton initializes at import time—before
	 * {@link browserState.whenReady} resolves. The focused window is seeded
	 * once browser data is available (see `whenReady.then` below).
	 */
	const expandedWindows = new SvelteSet<number>();

	// Seed focused window(s) once browser data is available.
	// Runs exactly once—after this, the user controls expansion via toggleWindow.
	void browserState.whenReady.then(() => {
		for (const w of browserState.windows) {
			if (w.focused) expandedWindows.add(w.id);
		}
	});

	/** Current search query for filtering. Empty = no filter. */
	let searchQuery = $state('');

	/** Whether a search filter is currently active. */
	const isFiltering = $derived(searchQuery.trim().length > 0);

	/**
	 * Pre-compiled regex for the current search query.
	 * Null when regex mode is off, query is empty, or the pattern is invalid.
	 * Computed once per reactive change—avoids recompiling per tab.
	 */
	const compiledRegex = $derived.by(() => {
		if (!searchRegex.current || !isFiltering) return null;
		try {
			return new RegExp(searchQuery, searchCaseSensitive.current ? '' : 'i');
		} catch {
			return null;
		}
	});

	/** Whether the current regex query has invalid syntax. */
	const isRegexInvalid = $derived(
		searchRegex.current && isFiltering && compiledRegex === null,
	);

	/** Escape special regex characters for safe use in `new RegExp()`. */
	function escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/** Test a single field value against the current search query using the active mode. */
	function testField(value: string, fieldType: 'title' | 'url'): boolean {
		if (searchRegex.current) {
			return compiledRegex?.test(value) ?? false;
		}

		if (searchExactMatch.current) {
			if (fieldType === 'title') {
				// Whole-word boundary match for titles
				try {
					const re = new RegExp(
						`\\b${escapeRegex(searchQuery)}\\b`,
						searchCaseSensitive.current ? '' : 'i',
					);
					return re.test(value);
				} catch {
					return false;
				}
			}
			// Exact URL match after normalization
			const normalizedValue = normalizeUrl(value);
			const normalizedQuery = normalizeUrl(searchQuery);
			if (searchCaseSensitive.current) {
				return normalizedValue === normalizedQuery;
			}
			return normalizedValue.toLowerCase() === normalizedQuery.toLowerCase();
		}

		// Default: substring includes
		const q = searchCaseSensitive.current
			? searchQuery
			: searchQuery.toLowerCase();
		const v = searchCaseSensitive.current ? value : value.toLowerCase();
		return v.includes(q);
	}

	/** Match against title and/or URL based on current search preferences. */
	function matchesFilter(
		title: string | undefined,
		url: string | undefined,
	): boolean {
		if (!isFiltering) return true;

		const t = title ?? '';
		const u = url ?? '';

		switch (searchField.current) {
			case 'title':
				return testField(t, 'title');
			case 'url':
				return testField(u, 'url');
			case 'all':
				return testField(t, 'title') || testField(u, 'url');
		}
	}

	/**
	 * Flat item array derived from browserState + savedTabState + bookmarkState.
	 *
	 * Respects section expansion, window expansion, and search filtering.
	 * When filtering is active, all sections and windows auto-expand and
	 * empty sections are hidden.
	 */
	const flatItems = $derived.by((): FlatItem[] => {
		const items: FlatItem[] = [];

		// ── Open Tabs section ──
		const totalTabs = browserState.windows.reduce(
			(sum, w) => sum + browserState.tabsByWindow(w.id).length,
			0,
		);

		if (isFiltering) {
			let openTabsMatchCount = 0;
			const openTabsItems: FlatItem[] = [];

			for (const window of browserState.windows) {
				const windowTabs = browserState.tabsByWindow(window.id);
				const matching = windowTabs.filter((tab) =>
					matchesFilter(tab.title, tab.url),
				);
				if (matching.length === 0) continue;

				openTabsMatchCount += matching.length;
				openTabsItems.push({ kind: 'window-header', window });
				for (const tab of matching) {
					openTabsItems.push({ kind: 'tab', tab });
				}
			}

			if (openTabsMatchCount > 0) {
				items.push({
					kind: 'section-header',
					section: 'open-tabs',
					label: 'Open Tabs',
					count: openTabsMatchCount,
				});
				items.push(...openTabsItems);
			}
		} else {
			items.push({
				kind: 'section-header',
				section: 'open-tabs',
				label: 'Open Tabs',
				count: totalTabs,
			});
			if (expandedSections.has('open-tabs')) {
				for (const window of browserState.windows) {
					items.push({ kind: 'window-header', window });
					if (expandedWindows.has(window.id)) {
						for (const tab of browserState.tabsByWindow(window.id)) {
							items.push({ kind: 'tab', tab });
						}
					}
				}
			}
		}

		// ── Saved for Later section ──
		const savedTabs = savedTabState.tabs;

		if (isFiltering) {
			const matchingSaved = savedTabs.filter((tab) =>
				matchesFilter(tab.title, tab.url),
			);
			if (matchingSaved.length > 0) {
				items.push({
					kind: 'section-header',
					section: 'saved',
					label: 'Saved for Later',
					count: matchingSaved.length,
				});
				for (const savedTab of matchingSaved) {
					items.push({ kind: 'saved-tab', savedTab });
				}
			}
		} else {
			items.push({
				kind: 'section-header',
				section: 'saved',
				label: 'Saved for Later',
				count: savedTabs.length,
			});
			if (expandedSections.has('saved')) {
				for (const savedTab of savedTabs) {
					items.push({ kind: 'saved-tab', savedTab });
				}
			}
		}

		// ── Bookmarks section ──
		const allBookmarks = bookmarkState.bookmarks;

		if (isFiltering) {
			const matchingBookmarks = allBookmarks.filter((b) =>
				matchesFilter(b.title, b.url),
			);
			if (matchingBookmarks.length > 0) {
				items.push({
					kind: 'section-header',
					section: 'bookmarks',
					label: 'Bookmarks',
					count: matchingBookmarks.length,
				});
				for (const bookmark of matchingBookmarks) {
					items.push({ kind: 'bookmark', bookmark });
				}
			}
		} else {
			items.push({
				kind: 'section-header',
				section: 'bookmarks',
				label: 'Bookmarks',
				count: allBookmarks.length,
			});
			if (expandedSections.has('bookmarks')) {
				for (const bookmark of allBookmarks) {
					items.push({ kind: 'bookmark', bookmark });
				}
			}
		}

		return items;
	});

	return {
		/** The flat item array for VList rendering. */
		get flatItems() {
			return flatItems;
		},

		/** Whether a search filter is currently active. */
		get isFiltering() {
			return isFiltering;
		},

		/** Current search query. */
		get searchQuery() {
			return searchQuery;
		},
		set searchQuery(value: string) {
			searchQuery = value;
		},

		/** Toggle a section's expanded state. */
		toggleSection(section: SectionId) {
			if (expandedSections.has(section)) {
				expandedSections.delete(section);
			} else {
				expandedSections.add(section);
			}
		},

		/** Check if a section is expanded. */
		isSectionExpanded(section: SectionId): boolean {
			return expandedSections.has(section);
		},

		/** Toggle a window's expanded state. */
		toggleWindow(windowId: number) {
			if (expandedWindows.has(windowId)) {
				expandedWindows.delete(windowId);
			} else {
				expandedWindows.add(windowId);
			}
		},

		/** Check if a window is expanded. */
		isWindowExpanded(windowId: number): boolean {
			return expandedWindows.has(windowId);
		},

		/** Whether search matching is case-sensitive. Persisted to chrome.storage. */
		get isCaseSensitive() {
			return searchCaseSensitive.current;
		},
		set isCaseSensitive(value: boolean) {
			searchCaseSensitive.current = value;
		},

		/** Whether the query is a regular expression. Mutually exclusive with exactMatch. */
		get isRegex() {
			return searchRegex.current;
		},
		set isRegex(value: boolean) {
			searchRegex.current = value;
			if (value) searchExactMatch.current = false;
		},

		/** Whether to match whole words (titles) or exact URLs. Mutually exclusive with regex. */
		get isExactMatch() {
			return searchExactMatch.current;
		},
		set isExactMatch(value: boolean) {
			searchExactMatch.current = value;
			if (value) searchRegex.current = false;
		},

		/** Which fields to search: all, title only, or URL only. */
		get searchField() {
			return searchField.current;
		},
		set searchField(value: 'all' | 'title' | 'url') {
			searchField.current = value;
		},

		/** Whether the current regex pattern has invalid syntax. */
		get isRegexInvalid() {
			return isRegexInvalid;
		},
	};
}

export const unifiedViewState = createUnifiedViewState();
