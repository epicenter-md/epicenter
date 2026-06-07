/**
 * Read a folder of markdown into the model, then classify it.
 *
 * This is the pure transform: given each file's path and raw content (and an
 * optional `matter.json` text), it produces the readable rows, the unreadable
 * files (kept separate, never dropped), and EITHER a modeled classification (a
 * valid `matter.json` was supplied) OR a raw untyped view (no model, or junk
 * model). The actual disk/Tauri listing lives in `vault.svelte.ts` (and the
 * `inspect` script) and hands its results here, so this transform is testable
 * without any filesystem.
 *
 * The model is the foundation, never inference: a usable `matter.json` classifies
 * the folder against a contract; without one, the folder is shown as RAW text
 * (no type guessing). A junk model degrades to the raw view with a diagnostic the
 * UI can show as a non-blocking banner. Turning a raw folder into a model
 * ("Create model from folder") is a deferred, schema-emitting step.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { classifyRows, type RowConformance } from './conformance';
import { type MatterModel, type MatterModelError, parseModel } from './model';
import { type MatterParseError, parseEntry, type Row } from './parse';

export type FolderEntry = { fileName: string; content: string };

/**
 * Why a file could not be read as text at all, before any parse is attempted:
 * the read-level failure (non-UTF-8 / permission) the watcher reports for a file
 * it cannot decode. Parse-level failures are {@link MatterParseError}; both land
 * in the same "Can't read" bucket.
 */
export const MatterReadError = defineErrors({
	Undecodable: () => ({
		message: 'File is not readable as UTF-8 text',
	}),
});
export type MatterReadError = InferErrors<typeof MatterReadError>;

/** A file that could not become a row, with the failure that stopped it. */
export type UnreadableFile = {
	fileName: string;
	error: MatterParseError | MatterReadError;
};

/**
 * The folder is classified against an explicit model: rows split into valid /
 * needs-attention by per-cell conformance.
 */
export type ModeledView = {
	mode: 'modeled';
	model: MatterModel;
	conformance: RowConformance[];
};

/**
 * No usable model: the folder is shown as a RAW untyped grid (every value as
 * plain text, no type inference). `columns` is the deterministic union of
 * frontmatter keys. `modelError` is set when a `matter.json` existed but was junk
 * (so the UI can say "couldn't read your model"), and unset when there simply is
 * no model.
 */
export type UnmodeledView = {
	mode: 'unmodeled';
	columns: string[];
	modelError?: MatterModelError;
};

export type FolderRead = {
	rows: Row[];
	unreadable: UnreadableFile[];
	view: ModeledView | UnmodeledView;
};

/**
 * The ordered column keys of an unmodeled folder: the union of every row's
 * frontmatter keys, most-frequent first then first-seen, so the raw grid is
 * deterministic across opens. No type inference: a folder without a model is
 * shown as raw text, never guessed into kinds.
 */
function frontmatterColumns(rows: readonly Row[]): string[] {
	const count = new Map<string, number>();
	const firstSeen: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row.frontmatter)) {
			if (!count.has(key)) firstSeen.push(key);
			count.set(key, (count.get(key) ?? 0) + 1);
		}
	}
	return firstSeen
		.map((key, index) => ({ key, index, count: count.get(key) ?? 0 }))
		.sort((a, b) => b.count - a.count || a.index - b.index)
		.map((c) => c.key);
}

/**
 * Read and classify a folder.
 *
 * @param entries the folder's `.md` files (basename + raw content).
 * @param modelText the raw text of the folder's `matter.json`, if present.
 */
export function readFolder(
	entries: readonly FolderEntry[],
	modelText?: string,
): FolderRead {
	const rows: Row[] = [];
	const unreadable: UnreadableFile[] = [];

	for (const { fileName, content } of entries) {
		const { data, error } = parseEntry(fileName, content);
		if (error) {
			unreadable.push({ fileName, error });
			continue;
		}
		rows.push(data);
	}

	return { rows, unreadable, view: buildView(rows, loadModel(modelText)) };
}

/**
 * A folder's model after the expensive load step: missing, junk (with a
 * diagnostic), or parsed AND compiled. `validateModel` compiles each field's
 * validator once, so the loaded model's `fields` are already the precompiled
 * validators; there is no separate compile step here.
 */
export type LoadedModel =
	| { kind: 'none' }
	| { kind: 'error'; error: MatterModelError }
	| { kind: 'loaded'; model: MatterModel };

/**
 * Parse AND compile a folder's `matter.json` ONCE. `validateModel` is where
 * compilation (`Schema.Compile`) happens, so memoize this off the model text (a
 * `$derived` in the live vault) and pass the result to {@link buildView}; a
 * single-file change then reclassifies against the cached fields without
 * recompiling.
 */
export function loadModel(modelText: string | undefined): LoadedModel {
	if (modelText === undefined) return { kind: 'none' };
	const { data: model, error } = parseModel(modelText);
	// Junk model carries its diagnostic so the UI can surface it; deleting
	// matter.json always recovers a working raw view.
	if (error) return { kind: 'error', error };
	return { kind: 'loaded', model };
}

/**
 * Classify a set of in-memory rows against an already-loaded model. Split out
 * from {@link readFolder} so the live vault can reclassify after a single-file
 * change without re-parsing the folder or recompiling the model.
 */
export function buildView(
	rows: readonly Row[],
	loaded: LoadedModel,
): ModeledView | UnmodeledView {
	if (loaded.kind === 'loaded') {
		return {
			mode: 'modeled',
			model: loaded.model,
			conformance: classifyRows(loaded.model.fields, rows),
		};
	}
	// No usable model: the raw untyped view, carrying the diagnostic if a
	// matter.json existed but was junk. Exhaustive over the remaining
	// 'none' | 'error' so a new LoadedModel variant fails to compile here
	// instead of silently rendering as an empty grid.
	const columns = frontmatterColumns(rows);
	switch (loaded.kind) {
		case 'none':
			return { mode: 'unmodeled', columns };
		case 'error':
			return { mode: 'unmodeled', columns, modelError: loaded.error };
		default:
			return loaded satisfies never;
	}
}
