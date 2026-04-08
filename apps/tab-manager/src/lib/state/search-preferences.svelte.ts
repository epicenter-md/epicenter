/**
 * Persisted search preferences backed by chrome.storage.local.
 *
 * Toggle states survive panel close/reopen and sync across extension
 * contexts (popup, sidebar) via chrome.storage.onChanged.
 *
 * @see {@link ./storage-state.svelte} — chrome.storage reactive wrapper
 */

import { type } from 'arktype';
import { createStorageState } from './storage-state.svelte';

/** Whether search matching is case-sensitive. */
export const searchCaseSensitive = createStorageState(
	'local:search.caseSensitive',
	{
		fallback: false,
		schema: type('boolean'),
	},
);

/** Whether the search query is interpreted as a regular expression. */
export const searchRegex = createStorageState('local:search.regex', {
	fallback: false,
	schema: type('boolean'),
});

/** Whether to match whole words (titles) or exact URLs. */
export const searchExactMatch = createStorageState('local:search.exactMatch', {
	fallback: false,
	schema: type('boolean'),
});

/** Which fields to search: all, title only, or URL only. */
export const searchField = createStorageState('local:search.field', {
	fallback: 'all' as const,
	schema: type("'all' | 'title' | 'url'"),
});
