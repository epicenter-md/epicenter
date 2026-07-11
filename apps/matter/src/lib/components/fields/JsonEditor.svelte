<script lang="ts">
	import { isMissing, type InvalidCell } from '@epicenter/matter-core';
	import { createCellEdit } from './create-cell-edit.svelte';
	import FieldMissing from './FieldMissing.svelte';
	import type { RenderableCell, SaveField } from './field-props';

	// JSON is the one text editor that can represent both a valid arbitrary-JSON
	// field and an INVALID raw value. ModeledCell still owns which lane reached this
	// component; this owns only the JSON text draft, parser, and display tone.
	// Parsing gates syntax only: a parseable value that still fails its field schema
	// saves, stays INVALID, and reclassifies through the row watcher.
	let { cell, save }: {
		cell: RenderableCell | InvalidCell;
		save: SaveField;
	} = $props();

	const value = $derived.by(() => {
		if (cell.state === 'INVALID') return cell.raw;
		if (cell.state === 'OK') return cell.value;
		return undefined;
	});

	const edit = createCellEdit({
		current: () => value,
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

	const invalid = $derived(cell.state === 'INVALID');
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		name={cell.field.name}
		aria-label={cell.field.name}
		autocomplete="off"
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
{:else if isMissing(cell)}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text rounded-sm px-1 py-0.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	>
		<FieldMissing {cell} />
	</button>
{:else}
	<button
		type="button"
		onclick={edit.start}
		class="block w-full cursor-text rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	>
		<code
			class={[
				'block truncate rounded px-1 text-xs',
				invalid
					? 'bg-destructive/10 text-destructive'
					: 'max-w-80 bg-muted/50 text-muted-foreground',
			]}>{JSON.stringify(value)}</code
		>
	</button>
{/if}
