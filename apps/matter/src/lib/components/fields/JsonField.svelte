<script lang="ts">
	import { createCellEdit } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './field-props';

	// The widget for the `json` kind: an arbitrary-JSON payload cell. Edit the
	// JSON-serialized value in one input and re-parse on commit, exactly like the
	// universal repair editor, because a json cell IS "any value, shown as JSON".
	// Parsing GATES the save (a syntax error is held open, never written); a parsed
	// value that still fails the field's payload schema reclassifies to INVALID and
	// routes to the repair editor on its own. An empty draft reverts; deleting the
	// key is the cell's shared chrome, not an emptied input here.
	let { cell, save }: FieldProps = $props();

	const edit = createCellEdit({
		current: () => (cell.state === 'OK' ? cell.value : undefined),
		save: (value) => save(value),
		display: (value) => (value === undefined ? '' : JSON.stringify(value)),
		parse: (text) => {
			if (text.trim() === '') return { type: 'cancel' };
			try {
				return { type: 'value', value: JSON.parse(text) };
			} catch {
				return { type: 'error', message: 'Not valid JSON' };
			}
		},
	});
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		spellcheck="false"
		class={[
			'w-full rounded border bg-background px-1 py-0.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
			edit.parseError
				? 'border-destructive focus-visible:ring-destructive'
				: 'focus-visible:border-ring focus-visible:ring-ring',
		]}
	/>
	{#if edit.parseError}
		<span class="mt-0.5 block text-xs text-destructive">{edit.parseError}</span>
	{/if}
{:else if cell.state === 'NEEDS_VALUE'}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text rounded-sm px-1 py-0.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	>
		<FieldEmpty />
	</button>
{:else}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	>
		<code class="block max-w-80 truncate rounded bg-muted/50 px-1 text-xs text-muted-foreground"
			>{JSON.stringify(cell.value)}</code
		>
	</button>
{/if}
