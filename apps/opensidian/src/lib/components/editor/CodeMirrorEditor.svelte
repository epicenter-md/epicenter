<script lang="ts">
	import { defaultKeymap, indentWithTab } from '@codemirror/commands';
	import { EditorState, type Extension } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';
	import { mode } from 'mode-watcher';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import type * as Y from 'yjs';
	import { editorState } from '$lib/state/editor-state.svelte';
	import { getEditorExtensions } from './extensions/language-support';

	let {
		ytext,
		filename = 'untitled.md',
		extensions: extraExtensions = [],
	}: {
		ytext: Y.Text;
		filename?: string;
		extensions?: Extension[];
	} = $props();

	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!container) return;
		const isDark = mode.current === 'dark';
		const view = new EditorView({
			state: EditorState.create({
				doc: ytext.toString(),
				extensions: [
					// vim() must be BEFORE other keymaps per @replit/codemirror-vim README.
					...editorState.createExtensions(isDark),
					keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
					drawSelection(),
					EditorView.lineWrapping,
					...getEditorExtensions(filename, isDark),
					yCollab(ytext, null),
					placeholder('Empty file'),
					...extraExtensions,
					EditorView.theme({
						'&': { height: '100%', fontSize: '14px' },
						'.cm-scroller': {
							fontFamily:
								'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
							padding: '1rem',
							overflow: 'auto',
						},
						'.cm-content': { caretColor: 'var(--foreground, currentColor)' },
						'.cm-focused': { outline: 'none' },
						'.cm-gutters': { display: 'none' },
						'.cm-activeLine': { backgroundColor: 'transparent' },
					}),
				],
			}),
			parent: container,
		});
		editorState.attach(view);
		return () => {
			view.destroy();
			editorState.detach();
		};
	});
</script>

<div
	class="h-full w-full overflow-hidden bg-transparent"
	bind:this={container}
></div>
