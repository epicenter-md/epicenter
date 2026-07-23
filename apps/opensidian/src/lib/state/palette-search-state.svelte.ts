import { asFileId } from '@epicenter/filesystem';
import { createPersistedState } from '@epicenter/svelte';
import type { CommandPaletteItem } from '@epicenter/ui/command-palette';
import { debounce } from '@epicenter/workspace';
import { type } from 'arktype';
import type { OpensidianBrowser } from 'opensidian/browser';
import { getFileIcon } from '$lib/utils/file-icons';
import type { FilesState } from './files-state.svelte';

export type SearchScope = 'names' | 'content' | 'both';

export function createPaletteSearchState({
	files,
	workspace,
}: {
	files: FilesState;
	workspace: OpensidianBrowser;
}) {
	// Persisted scope preference
	const scopeState = createPersistedState({
		key: 'opensidian.search.scope',
		schema: type("'names' | 'content' | 'both'"),
		defaultValue: 'both' as SearchScope,
	});

	// Search query bound to palette input
	let searchQuery = $state('');

	// Content search results (updated via debounce)
	let contentResults = $state.raw<CommandPaletteItem[]>([]);
	let isSearching = $state(false);

	// ── File items (instant, in-memory) ─────────────────────────────
	const fileItems = $derived.by((): CommandPaletteItem[] => {
		return files.walkTree<CommandPaletteItem>((id, row) => {
			if (row.type === 'file') {
				const fullPath = files.getPath(id) ?? '';
				const lastSlash = fullPath.lastIndexOf('/');
				const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
				return {
					collect: {
						id,
						label: row.name,
						description: parentDir || undefined,
						icon: getFileIcon(row.name),
						group: 'Files',
						onSelect: () => files.selectFile(asFileId(id)),
					},
					descend: false,
				};
			}
			return { descend: true };
		});
	});

	const nameResults = $derived.by((): CommandPaletteItem[] => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return fileItems;
		return fileItems.filter((item) => item.label.toLowerCase().includes(query));
	});

	// ── Content search (debounced FTS5) ─────────────────────────────
	const runContentSearch = debounce(async (trimmed: string) => {
		try {
			const scope = scopeState.current;
			// Add column filter for content-only mode
			const ftsQuery = scope === 'content' ? `content:${trimmed}` : trimmed;
			const results = await workspace.sqliteIndex.search(ftsQuery);

			contentResults = results.map((r) => ({
				id: r.id,
				label: r.name,
				description: r.path
					? r.path.slice(1, r.path.lastIndexOf('/')) || undefined
					: undefined,
				snippet: r.snippet,
				icon: getFileIcon(r.name),
				group: 'Content Matches',
				onSelect: () => files.selectFile(asFileId(r.id)),
			}));
		} catch {
			contentResults = [];
		} finally {
			isSearching = false;
		}
	}, 150);

	function triggerContentSearch(query: string) {
		const trimmed = query.trim();
		if (trimmed.length < 2) {
			runContentSearch.cancel();
			contentResults = [];
			isSearching = false;
			return;
		}

		isSearching = true;
		runContentSearch(trimmed);
	}

	// ── Merged results (derived from scope) ─────────────────────────
	const searchResults = $derived.by((): CommandPaletteItem[] => {
		const scope = scopeState.current;

		switch (scope) {
			case 'names':
				return fileItems;
			case 'content':
				return contentResults;
			case 'both': {
				// Name matches first, then content matches, deduped by ID
				const nameIds = new Set(nameResults.map((r) => r.id));
				const dedupedContent = contentResults.filter((r) => !nameIds.has(r.id));
				return [...nameResults, ...dedupedContent];
			}
		}
	});

	return {
		get scope() {
			return scopeState.current;
		},
		set scope(value: SearchScope) {
			scopeState.current = value;
			// Re-trigger content search when scope changes
			if (value !== 'names' && searchQuery.trim().length >= 2) {
				triggerContentSearch(searchQuery);
			}
		},

		get searchQuery() {
			return searchQuery;
		},
		set searchQuery(value: string) {
			searchQuery = value;
			const scope = scopeState.current;
			// Trigger content search for content/both modes
			if (scope !== 'names') {
				triggerContentSearch(value);
			}
		},

		get searchResults() {
			return searchResults;
		},

		get isSearching() {
			return isSearching;
		},

		/** Whether the palette should use its built-in filter (names mode only). */
		get shouldFilter() {
			return scopeState.current === 'names';
		},

		/** Reset state when palette closes. */
		reset() {
			searchQuery = '';
			contentResults = [];
			isSearching = false;
			runContentSearch.cancel();
		},
		[Symbol.dispose]() {
			runContentSearch.cancel();
		},
	};
}
