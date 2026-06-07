<script lang="ts">
	import type { InvalidCell } from '$lib/core/conformance';
	import { createCellEdit } from './fields/create-cell-edit.svelte';
	import type { SaveField } from './fields/field-props';

	// The universal repair editor for an INVALID cell, chosen by ModeledCell before
	// any per-kind Field. Edit the JSON-serialized value and re-parse on commit:
	// JSON (not the bare scalar) because at the type boundary explicit identity is
	// the point ("1240s" reads as a string, not a number) and it round-trips any
	// shape. Parsing GATES the save (a syntax error is held, never written); the
	// model never gates a write, so a still-invalid-but-parseable value saves and
	// stays INVALID. The row reclassifies through the watcher, so a now-valid value
	// snaps back to its typed Field on its own. An empty draft reverts; deleting the
	// key is the cell's chrome, the same control every kind gets.
	let { cell, save }: {
		cell: InvalidCell;
		save: SaveField;
	} = $props();

	const edit = createCellEdit({
		current: () => cell.raw,
		save: (value) => save(value),
		display: (value) => JSON.stringify(value) ?? '',
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
		class={[
			'w-full rounded border bg-background px-1 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
			edit.parseError
				? 'border-destructive focus-visible:ring-destructive'
				: 'focus-visible:border-ring focus-visible:ring-ring',
		]}
	/>
	{#if edit.parseError}
		<span class="mt-0.5 block text-xs text-destructive">{edit.parseError}</span>
	{/if}
{:else}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	>
		<code class="block truncate rounded bg-destructive/10 px-1 text-xs text-destructive"
			>{JSON.stringify(cell.raw)}</code
		>
	</button>
{/if}
