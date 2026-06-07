/**
 * The shared editing lifecycle for text-input Field components.
 *
 * Five kinds (string, integer, number, url, datetime) and the universal JSON
 * repair editor all edit through a single text input: click to open, type into a
 * local draft, commit on blur/Enter, revert on Escape. That lifecycle, the no-op
 * guard, and the keystroke-buffer "detach while open" invariant are IDENTICAL
 * across them; only the display and the parse differ. This rune helper owns the
 * lifecycle; each Field supplies `display(value) -> text` and `parse(text)`.
 *
 * `parse` returns a DISCRIMINATED result, not a bare value: `value` commits
 * through {@link SaveField}, `cancel` reverts and closes without writing (an empty
 * draft for a kind that has no empty value, so there is nothing to commit), and
 * `error` holds the draft open with a message (the JSON repair editor's bad-syntax
 * case). Deleting the key is NOT a parse outcome: clearing the cell is the shared
 * chrome on {@link ModeledCell}, never an overloaded empty draft.
 *
 * The returned object is GETTER-BACKED reactive state (plus a `draft` setter for
 * `bind:value`): dot-access it, never destructure, or you snapshot the value and
 * lose reactivity.
 */

import type { SaveField } from './field-props';

export type CellEditParse =
	| { type: 'value'; value: unknown }
	| { type: 'cancel' }
	| { type: 'error'; message: string };

type CreateCellEditOptions = {
	/**
	 * The cell's current committed value, as a getter (not a snapshot): props can
	 * change between `start` and `commit`, and `undefined` means empty. The island
	 * edits a scalar, so it takes the value directly, never the cell's state or field.
	 */
	current: () => unknown;
	save: SaveField;
	/**
	 * Serialize the committed value into the input's initial text. Defaults to
	 * `String` (empty for nullish), the plain-text case; only the JSON repair editor
	 * overrides it (`JSON.stringify`, so a type-confused value shows its quotes).
	 */
	display?: (value: unknown) => string;
	/** Interpret the draft text on commit. */
	parse: (draft: string) => CellEditParse;
};

export function createCellEdit(options: CreateCellEditOptions) {
	const {
		current,
		save,
		display = (value) => (value == null ? '' : String(value)),
		parse,
	} = options;
	let editing = $state(false);
	let draft = $state('');
	let parseError = $state<string | undefined>(undefined);

	function start() {
		draft = display(current());
		parseError = undefined;
		editing = true;
	}

	function cancel() {
		editing = false;
		parseError = undefined;
	}

	function commit() {
		const result = parse(draft);
		if (result.type === 'error') {
			// Hold the edit open with the message; never write unparseable text.
			parseError = result.message;
			return;
		}
		// An empty draft for a kind with no empty value just reverts: close, write
		// nothing. (Clearing the key is the cell's chrome, not an empty input here.)
		if (result.type === 'cancel') {
			cancel();
			return;
		}
		editing = false;
		const value = current();
		// Opening an empty cell and committing a blank value is not a real edit: don't
		// phantom-create an empty-string key on a stray focus/blur. You reach the empty
		// string by ERASING an existing value; an already-empty cell stays empty. (Only
		// `string` can produce a `''` value; the other text kinds cancel a blank draft.)
		if (value == null && result.value === '') return;
		// No-op guard: re-committing the same scalar must not write (and trigger a
		// pointless watcher echo).
		if (result.value !== value) save(result.value);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') commit();
		else if (event.key === 'Escape') cancel();
	}

	return {
		get editing() {
			return editing;
		},
		get draft() {
			return draft;
		},
		set draft(value: string) {
			draft = value;
			// Typing clears a stale parse error so the field can recover.
			parseError = undefined;
		},
		get parseError() {
			return parseError;
		},
		start,
		commit,
		cancel,
		onKeydown,
	};
}
