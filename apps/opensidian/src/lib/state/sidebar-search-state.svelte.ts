import { createPersistedState } from '@epicenter/svelte';
import { debounce } from '@epicenter/workspace';
import { type } from 'arktype';
import type { OpensidianBrowser } from 'opensidian/browser';

export type MatchSnippet = {
	snippet: string;
};

export type FileGroup = {
	fileId: string;
	fileName: string;
	filePath: string | null;
	matchCount: number;
	matches: MatchSnippet[];
};

const PAGE_SIZE = 50;

export function createSidebarSearchState({
	workspace,
}: {
	workspace: OpensidianBrowser;
}) {
	// Persisted preferences
	const caseSensitiveState = createPersistedState({
		key: 'opensidian.sidebar-search.case-sensitive',
		schema: type('boolean'),
		defaultValue: false,
	});

	const regexState = createPersistedState({
		key: 'opensidian.sidebar-search.regex',
		schema: type('boolean'),
		defaultValue: false,
	});

	const leftPaneViewState = createPersistedState({
		key: 'opensidian.left-pane-view',
		schema: type("'files' | 'search'"),
		defaultValue: 'files' as 'files' | 'search',
	});

	// Mutable state
	let searchQuery = $state('');
	let fileGroups = $state.raw<FileGroup[]>([]);
	let isSearching = $state(false);
	let totalResults = $state(0);
	let totalFiles = $state(0);
	let hasMore = $state(false);
	let currentOffset = 0;

	function groupByFile(
		rows: Array<{
			fileId: string;
			name: string;
			path: string | null;
			snippet: string;
		}>,
	): FileGroup[] {
		const groups = new Map<string, FileGroup>();
		for (const row of rows) {
			let group = groups.get(row.fileId);
			if (!group) {
				group = {
					fileId: row.fileId,
					fileName: row.name,
					filePath: row.path,
					matchCount: 0,
					matches: [],
				};
				groups.set(row.fileId, group);
			}
			group.matchCount++;
			group.matches.push({ snippet: row.snippet });
		}
		return Array.from(groups.values());
	}

	function applyPostFilters(
		rows: Array<{
			fileId: string;
			name: string;
			path: string | null;
			snippet: string;
		}>,
		query: string,
		caseSensitive: boolean,
		regex: boolean,
	) {
		let filtered = rows;

		if (caseSensitive) {
			filtered = filtered.filter(
				(r) => r.snippet.includes(query) || r.name.includes(query),
			);
		}

		if (regex) {
			try {
				const re = new RegExp(query, caseSensitive ? '' : 'i');
				filtered = filtered.filter(
					(r) => re.test(r.snippet) || re.test(r.name),
				);
			} catch {
				// Invalid regex: return unfiltered (FTS already matched)
			}
		}

		return filtered;
	}

	async function executeSearch(query: string, offset: number) {
		const client = workspace.sqliteIndex.client;
		const trimmed = query.trim();

		try {
			const result = await client.execute({
				sql: `SELECT
				  fts.file_id,
				  f.name,
				  f.path,
				  snippet(files_fts, 2, '<mark>', '</mark>', '...', 64) AS snippet
				FROM files_fts fts
				JOIN files f ON f.id = fts.file_id
				WHERE files_fts MATCH ?
				ORDER BY rank
				LIMIT ? OFFSET ?`,
				args: [trimmed, PAGE_SIZE + 1, offset],
			});

			const rows = result.rows.map((row) => ({
				fileId: row.file_id as string,
				name: row.name as string,
				path: (row.path as string | null) ?? null,
				snippet: row.snippet as string,
			}));

			const hasMoreResults = rows.length > PAGE_SIZE;
			const pageRows = hasMoreResults ? rows.slice(0, PAGE_SIZE) : rows;

			// Apply post-filters for case sensitivity and regex
			const filtered = applyPostFilters(
				pageRows,
				trimmed,
				caseSensitiveState.current,
				regexState.current,
			);

			return {
				rows: filtered,
				hasMore: hasMoreResults,
				consumedRows: pageRows.length,
			};
		} catch {
			// Invalid FTS5 query syntax
			return { rows: [], hasMore: false, consumedRows: 0 };
		}
	}

	const runSearch = debounce(async (trimmed: string) => {
		currentOffset = 0;
		const result = await executeSearch(trimmed, 0);

		const groups = groupByFile(result.rows);
		fileGroups = groups;
		totalResults = result.rows.length;
		totalFiles = groups.length;
		hasMore = result.hasMore;
		currentOffset = result.consumedRows;
		isSearching = false;
	}, 200);

	function triggerSearch(query: string) {
		const trimmed = query.trim();
		if (trimmed.length < 2) {
			runSearch.cancel();
			fileGroups = [];
			totalResults = 0;
			totalFiles = 0;
			hasMore = false;
			isSearching = false;
			currentOffset = 0;
			return;
		}

		isSearching = true;
		runSearch(trimmed);
	}

	return {
		get searchQuery() {
			return searchQuery;
		},
		set searchQuery(value: string) {
			searchQuery = value;
			triggerSearch(value);
		},

		get caseSensitive() {
			return caseSensitiveState.current;
		},
		set caseSensitive(value: boolean) {
			caseSensitiveState.current = value;
			if (searchQuery.trim().length >= 2) triggerSearch(searchQuery);
		},

		get regex() {
			return regexState.current;
		},
		set regex(value: boolean) {
			regexState.current = value;
			if (searchQuery.trim().length >= 2) triggerSearch(searchQuery);
		},

		get isSearching() {
			return isSearching;
		},
		get fileGroups() {
			return fileGroups;
		},
		get totalResults() {
			return totalResults;
		},
		get totalFiles() {
			return totalFiles;
		},
		get hasMore() {
			return hasMore;
		},

		get leftPaneView() {
			return leftPaneViewState.current;
		},
		set leftPaneView(value: 'files' | 'search') {
			leftPaneViewState.current = value;
		},

		openSearch() {
			leftPaneViewState.current = 'search';
		},

		closeSearch() {
			leftPaneViewState.current = 'files';
		},

		async loadMore() {
			if (!hasMore || isSearching) return;
			const trimmed = searchQuery.trim();
			if (trimmed.length < 2) return;

			isSearching = true;
			const result = await executeSearch(trimmed, currentOffset);

			const newGroups = groupByFile(result.rows);

			// Merge into existing groups
			const mergedMap = new Map<string, FileGroup>();
			for (const g of fileGroups)
				mergedMap.set(g.fileId, { ...g, matches: [...g.matches] });
			for (const g of newGroups) {
				const existing = mergedMap.get(g.fileId);
				if (existing) {
					existing.matches.push(...g.matches);
					existing.matchCount += g.matchCount;
				} else {
					mergedMap.set(g.fileId, g);
				}
			}

			fileGroups = Array.from(mergedMap.values());
			totalResults += result.rows.length;
			totalFiles = fileGroups.length;
			hasMore = result.hasMore;
			currentOffset += result.consumedRows;
			isSearching = false;
		},

		[Symbol.dispose]() {
			runSearch.cancel();
		},
	};
}
