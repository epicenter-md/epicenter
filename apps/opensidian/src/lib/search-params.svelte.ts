/**
 * Typed URL search param state for Opensidian.
 *
 * The URL is the single source of truth for active file and chat selection.
 * This module defines the complete param schema, provides reactive getters
 * (via `page.url.searchParams`), and a batch `update()` that writes all
 * changes in a single `goto()` call.
 *
 * Defaults are elided from the URL to keep it clean. `/` means no file or
 * chat selected.
 *
 * @example
 * ```typescript
 * import { searchParams } from '$lib/search-params.svelte';
 *
 * // Read (reactive: tracked by $derived automatically)
 * const fileId = searchParams.file;
 * const chatId = searchParams.chat;
 *
 * // Write (atomic: one goto())
 * searchParams.update({ file: fileId, chat: null });
 * ```
 */

import { asFileId, type FileId } from '@epicenter/filesystem';
import { asConversationId, type ConversationId } from 'opensidian';
import { goto } from '$app/navigation';
import { page } from '$app/state';

/**
 * The complete URL state schema for Opensidian.
 *
 * Every search param the app uses, its TypeScript type, and its default value.
 * Typos in `update({ fil: ... })` are compile-time errors.
 */
type SearchParams = {
	file: FileId | null;
	chat: ConversationId | null;
};

/** Values that get elided from the URL: presence means non-default. */
const DEFAULTS = {
	file: null,
	chat: null,
} satisfies SearchParams;

function createSearchParams() {
	/**
	 * Batch-update URL search params in a single navigation.
	 *
	 * Clones the current URL, applies all changes, elides defaults, then
	 * navigates once. No history entry, no scroll jump, no focus loss.
	 *
	 * @example
	 * ```typescript
	 * searchParams.update({ file: fileId });
	 * searchParams.update({ chat: conversationId });
	 * searchParams.update({ file: null }); // clear
	 * ```
	 */
	function update(changes: Partial<SearchParams>) {
		const url = new URL(page.url);
		for (const [key, value] of Object.entries(changes)) {
			const def = DEFAULTS[key as keyof SearchParams];
			if (value === null || value === '' || value === def) {
				url.searchParams.delete(key);
			} else {
				url.searchParams.set(key, String(value));
			}
		}
		goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	return {
		/** Currently active file, or `null` for no selection. */
		get file(): FileId | null {
			const raw = page.url.searchParams.get('file');
			return raw ? asFileId(raw) : null;
		},

		/** Currently active chat conversation, or `null` for none. */
		get chat(): ConversationId | null {
			const raw = page.url.searchParams.get('chat');
			return raw ? asConversationId(raw) : null;
		},

		update,
	};
}

export const searchParams = createSearchParams();
