/**
 * Pure tab-analysis helpers shared by QuickActions and workspace actions.
 *
 * These functions take a tab array and return analysis results—no dependency
 * on `browserState`, `tables`, or any other reactive/CRDT data source.
 * Consumers provide their own tab arrays from whatever source they use.
 *
 * @example
 * ```typescript
 * import { findDuplicateGroups, groupTabsByDomain } from '$lib/utils/tab-helpers';
 *
 * // QuickAction consumer — feeds browserState tabs
 * const dupes = findDuplicateGroups(getAllTabs());
 *
 * // Workspace action consumer — feeds Y.Doc tabs
 * const dupes = findDuplicateGroups(tables.tabs.getAllValid());
 * ```
 */

import { Ok, trySync } from 'wellcrafted/result';
import { getDomain } from '$lib/utils/format';

/**
 * Normalize a URL for duplicate comparison.
 *
 * Strips trailing slash, query params, and hash to treat
 * `https://github.com/foo` and `https://github.com/foo?ref=bar#readme`
 * as the same page.
 *
 * @example
 * ```typescript
 * normalizeUrl('https://github.com/foo?ref=bar#readme')
 * // 'https://github.com/foo'
 *
 * normalizeUrl('https://example.com/')
 * // 'https://example.com'
 * ```
 */
export function normalizeUrl(url: string): string {
	const { data } = trySync({
		try: () => {
			const parsed = new URL(url);
			return parsed.origin + parsed.pathname.replace(/\/$/, '');
		},
		catch: () => Ok(url),
	});
	return data;
}

/**
 * A tab-like object with the minimum fields needed for duplicate detection.
 *
 * Generic so both browserState tabs and Y.Doc table rows can satisfy it.
 */
type TabLike = {
	id: string;
	url?: string | undefined;
	title?: string | undefined;
};

/**
 * Find groups of tabs with the same normalized URL.
 *
 * Returns only groups with 2+ tabs (actual duplicates).
 * Within each group, tabs are ordered by their original array position,
 * so `group[0]` is the "keep" candidate and `group.slice(1)` are duplicates.
 *
 * @example
 * ```typescript
 * const tabs = [
 *   { id: 'a', url: 'https://github.com/foo', title: 'Foo' },
 *   { id: 'b', url: 'https://github.com/foo?ref=bar', title: 'Foo' },
 *   { id: 'c', url: 'https://example.com', title: 'Example' },
 * ];
 *
 * const dupes = findDuplicateGroups(tabs);
 * // Map { 'https://github.com/foo' => [tab-a, tab-b] }
 * ```
 */
export function findDuplicateGroups<T extends TabLike>(
	tabs: T[],
): Map<string, T[]> {
	const byUrl = new Map<string, T[]>();

	for (const tab of tabs) {
		if (!tab.url) continue;
		const normalized = normalizeUrl(tab.url);
		const group = byUrl.get(normalized) ?? [];
		group.push(tab);
		byUrl.set(normalized, group);
	}

	return new Map([...byUrl].filter(([, group]) => group.length > 1));
}

/**
 * Group tabs by their domain (hostname).
 *
 * Returns a Map from domain string to the tabs on that domain.
 * Tabs without a URL are skipped. Includes all domains, even those
 * with a single tab—callers should filter to 2+ if needed.
 *
 * @example
 * ```typescript
 * const tabs = [
 *   { id: 'a', url: 'https://github.com/foo' },
 *   { id: 'b', url: 'https://github.com/bar' },
 *   { id: 'c', url: 'https://youtube.com/watch?v=1' },
 * ];
 *
 * const domains = groupTabsByDomain(tabs);
 * // Map { 'github.com' => [tab-a, tab-b], 'youtube.com' => [tab-c] }
 * ```
 */
export function groupTabsByDomain<T extends TabLike>(
	tabs: T[],
): Map<string, T[]> {
	const byDomain = new Map<string, T[]>();

	for (const tab of tabs) {
		if (!tab.url) continue;
		const domain = getDomain(tab.url);
		if (!domain) continue;
		const group = byDomain.get(domain) ?? [];
		group.push(tab);
		byDomain.set(domain, group);
	}

	return byDomain;
}
