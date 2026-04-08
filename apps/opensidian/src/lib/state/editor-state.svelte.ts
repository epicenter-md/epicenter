import {
	type EditorState as CMEditorState,
	Compartment,
	type Extension,
	type Text,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createPersistedState } from '@epicenter/svelte';
import { Vim, vim } from '@replit/codemirror-vim';
import { type } from 'arktype';
import { yUndoManagerKeymap } from 'y-codemirror.next';

// ── Persisted preferences ───────────────────────────────────────

const vimPreference = createPersistedState({
	key: 'opensidian.vim-mode',
	schema: type('boolean'),
	defaultValue: false,
});

// ── Singleton factory ───────────────────────────────────────────

/**
 * Reactive editor state singleton.
 *
 * Bridges CodeMirror 6 editor state into Svelte 5 reactivity via
 * an `EditorView.updateListener` that pushes values into `$state`.
 * Components import the singleton and read getters directly—fine-grained
 * reactivity means only consumers of a changed value re-render.
 *
 * Vim preference is backed by `createPersistedState`—cross-tab sync
 * and focus-based re-reads come free.
 *
 * Follows the same factory pattern as `fs-state.svelte.ts` and
 * `terminal-state.svelte.ts`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { editorState } from '$lib/state/editor-state.svelte';
 *   // Reactive reads — only re-render when the specific value changes
 *   const line = $derived(editorState.cursorLine);
 * </script>
 *
 * <span>Ln {editorState.cursorLine}, Col {editorState.cursorCol}</span>
 * <button onclick={() => editorState.toggleVim()}>
 *   {editorState.vimEnabled ? 'VIM' : 'NORMAL'}
 * </button>
 * ```
 */
function createEditorState() {
	// ── Vim global config (idempotent, runs once at construction) ──

	const yUndo = yUndoManagerKeymap.find((k) => k.key === 'Mod-z')?.run;
	const yRedo = yUndoManagerKeymap.find((k) => k.key === 'Mod-y')?.run;

	// Remap j→gj and k→gk so cursor movement respects line wrapping.
	Vim.map('j', 'gj', 'normal');
	Vim.map('k', 'gk', 'normal');

	// Override Vim's built-in undo/redo to route through the Yjs UndoManager.
	// Without this, Vim's `u` and `Ctrl-R` call CodeMirror's `history()` undo—
	// which isn't configured because all edits flow through Yjs.
	if (yUndo && yRedo) {
		Vim.defineAction('undo', (cm, actionArgs) => {
			for (let i = 0; i < actionArgs.repeat; i++) yUndo(cm.cm6);
		});
		Vim.defineAction('redo', (cm, actionArgs) => {
			for (let i = 0; i < actionArgs.repeat; i++) yRedo(cm.cm6);
		});
	}

	function countWords(doc: Text): number {
		let count = 0;
		const iter = doc.iter();
		while (!iter.next().done) {
			const matches = iter.value.match(/\S+/g);
			if (matches) count += matches.length;
		}
		return count;
	}

	/** Sync cursor/selection reactive state from a CM6 EditorState. */
	function syncCursorFromState(state: CMEditorState): void {
		const head = state.selection.main.head;
		const line = state.doc.lineAt(head);
		cursorLine = line.number;
		cursorCol = head - line.from;
		const { from, to } = state.selection.main;
		selectionLength = to - from;
	}

	// ── Reactive state ──────────────────────────────────────────
	let view = $state<EditorView | null>(null);
	let wordCount = $state(0);
	let cursorLine = $state(1);
	let cursorCol = $state(0);
	let selectionLength = $state(0);
	let lineCount = $state(1);

	// ── Compartments ────────────────────────────────────────────
	const vimCompartment = new Compartment();

	// ── Update listener (CM6 → $state bridge) ───────────────────
	const listener = EditorView.updateListener.of((update) => {
		if (update.docChanged) {
			wordCount = countWords(update.state.doc);
			lineCount = update.state.doc.lines;
		}
		if (update.docChanged || update.selectionSet) {
			syncCursorFromState(update.state);
		}
	});

	return {
		// ── Read-only getters ───────────────────────────────────
		get vimEnabled() {
			return vimPreference.current;
		},
		get wordCount() {
			return wordCount;
		},
		get cursorLine() {
			return cursorLine;
		},
		get cursorCol() {
			return cursorCol;
		},
		get selectionLength() {
			return selectionLength;
		},
		get lineCount() {
			return lineCount;
		},

		/**
		 * Build a fresh set of CM6 extensions for a new EditorView.
		 *
		 * Returns the vim compartment, dark theme, and the update listener
		 * that bridges CM6 → `$state`. Call once per view creation—do NOT
		 * reuse across views.
		 *
		 * Must be placed **before** other keymap extensions per the
		 * `@replit/codemirror-vim` README—vim uses ViewPlugin eventHandlers
		 * for key dispatch, but ordering affects insert-mode key fallthrough.
		 *
		 * @param isDark Whether the editor is in dark mode. Passed by
		 * the component that owns the `mode-watcher` dependency.
		 */
		createExtensions(isDark: boolean): Extension[] {
			const vimEnabled = vimPreference.current;
			return [
				vimCompartment.of(vimEnabled ? vim() : []),
				isDark ? EditorView.theme({}, { dark: true }) : [],
				listener,
			];
		},

		/**
		 * Register the active EditorView.
		 *
		 * Call from the `$effect` that creates the view. For split-screen,
		 * call on focus change to update which editor feeds the status bar.
		 */
		attach(v: EditorView) {
			view = v;
			wordCount = countWords(v.state.doc);
			lineCount = v.state.doc.lines;
			syncCursorFromState(v.state);
		},

		/** Unregister the active EditorView (call from `$effect` cleanup). */
		detach() {
			view = null;
		},

		/**
		 * Toggle vim mode on the active editor.
		 *
		 * Persists preference via `createPersistedState` (cross-tab sync
		 * included) and reconfigures the compartment.
		 */
		toggleVim() {
			const next = !vimPreference.current;
			vimPreference.current = next;
			view?.dispatch({
				effects: vimCompartment.reconfigure(next ? vim() : []),
			});
		},
	};
}

export const editorState = createEditorState();
