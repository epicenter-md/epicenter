<script lang="ts">
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import { EditorState } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';

	let {
		body,
		onCommit,
	}: {
		body: string;
		onCommit: (body: string) => void;
	} = $props();

	let container: HTMLDivElement | undefined = $state();
	// svelte-ignore state_referenced_locally
	let draft = $state(body);
	// svelte-ignore state_referenced_locally
	let lastCommitted = $state(body);

	function commit() {
		if (draft === lastCommitted) return;
		lastCommitted = draft;
		onCommit(draft);
	}

	$effect(() => {
		if (!container) return;

		const view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: body,
				extensions: [
					history(),
					keymap.of([...historyKeymap, ...defaultKeymap]),
					drawSelection(),
					EditorView.lineWrapping,
					markdown(),
					placeholder('Start writing'),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) draft = update.state.doc.toString();
					}),
					EditorView.domEventHandlers({
						blur: commit,
					}),
					EditorView.theme({
						'&': {
							minHeight: '22rem',
							backgroundColor: 'transparent',
							color: 'hsl(var(--foreground))',
							fontSize: '14px',
						},
						'&.cm-focused': {
							outline: 'none',
						},
						'.cm-scroller': {
							fontFamily:
								'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
							lineHeight: '1.65',
							overflow: 'auto',
						},
						'.cm-content': {
							minHeight: '22rem',
							padding: '1rem',
							caretColor: 'hsl(var(--foreground))',
						},
						'.cm-cursor': {
							borderLeftColor: 'hsl(var(--foreground))',
						},
						'.cm-gutters': { display: 'none' },
						'.cm-activeLine': { backgroundColor: 'transparent' },
						'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
							backgroundColor: 'hsl(var(--primary) / 0.18)',
						},
						'.cm-placeholder': {
							color: 'hsl(var(--muted-foreground))',
						},
					}),
				],
			}),
		});

		return () => {
			commit();
			view.destroy();
		};
	});
</script>

<div
	class="overflow-hidden rounded-md border bg-background shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20"
	bind:this={container}
></div>
