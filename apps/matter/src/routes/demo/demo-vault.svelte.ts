/**
 * An in-memory {@link FolderGridVault}, used by the `/demo` route so the grid renders
 * (and edits) in a plain browser with no native folder watcher.
 *
 * It satisfies the same narrow contract the grid depends on, NOT the full vault: there
 * is no disk to watch, reconcile, or path to, so it does not pretend to (`watch` /
 * `status` / `path` are absent rather than faked no-ops). What it DOES share
 * is faithful, not a mock: it holds the same raw `.md` text the disk would, and a save
 * runs the REAL transforms ({@link editField} / {@link editBody}) then re-parses and
 * re-classifies through {@link readFolder}, exactly as the live vault does after the
 * watcher echoes a write back. So what you see and edit here is the same pipeline
 * production uses, minus the IO. The fixtures are inlined (the sample vault lives outside
 * the app root), so the route is self-contained.
 */

import { SvelteMap } from 'svelte/reactivity';
import { type FolderRead, readFolder } from '$lib/core/folder';
import { editBody, editField } from '$lib/core/serialize';
import type { FolderGridVault } from '$lib/vault.svelte';
import { DEMO_MODEL_TEXT, DEMO_ROWS } from './fixtures';

/** Open the inlined fixtures as a live, editable in-memory {@link FolderGridVault}. */
export function createDemoVault(folderName = 'sample-vault/drafts') {
	// filename -> raw markdown text, the same shape the disk holds. A save replaces
	// an entry's text, mirroring the watcher echoing a written file back.
	const entries = new SvelteMap<string, string>(
		DEMO_ROWS.map((row) => [row.fileName, row.content]),
	);

	const read = $derived.by(
		(): FolderRead =>
			readFolder(
				[...entries].map(([fileName, content]) => ({ fileName, content })),
				DEMO_MODEL_TEXT,
			),
	);

	/** Apply one transform to a file's freshest text, the demo's analog of `write`. */
	function edit(fileName: string, transform: (raw: string) => string) {
		const raw = entries.get(fileName);
		if (raw === undefined) return;
		entries.set(fileName, transform(raw));
	}

	return {
		folderName,
		/**
		 * Set or clear one frontmatter field (`undefined` clears the key). The edit is
		 * synchronous in memory; the signature stays `async` to match the live vault's
		 * write command surface, so the grid drives both the same way.
		 */
		async saveField(fileName: string, key: string, value: unknown) {
			edit(fileName, (raw) => editField(raw, key, value));
		},
		/** Replace a file's body, keeping its frontmatter intact. */
		async saveBody(fileName: string, body: string) {
			edit(fileName, (raw) => editBody(raw, body));
		},
		/** The current classified folder. A pure read with no side effects. */
		get read(): FolderRead {
			return read;
		},
	} satisfies FolderGridVault;
}
