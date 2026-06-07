<script lang="ts">
	import { createCellEdit, type CellEditParse } from './create-cell-edit.svelte';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { RenderableCell, SaveField } from './field-props';

	// The shared shell for the plain-text cell kinds (string, numeric, datetime):
	// click to open one text input, commit on blur/Enter, revert on Escape, with the
	// value always shown through String(). Those kinds differ ONLY in how a draft
	// PARSES (a number coerces; a string is verbatim) and in formatting CLASSES
	// (tabular digits vs truncated text), so those are the only props. Kinds with a
	// different non-editing display (url's link, json's repair code) keep their own
	// template and call createCellEdit directly; this shell is the common case, not
	// a universal cell.
	let {
		cell,
		save,
		parse,
		inputClass = '',
		displayClass = '',
		inputmode,
	}: {
		cell: RenderableCell;
		save: SaveField;
		/** Interpret the draft on commit (the one thing the text kinds differ on). */
		parse: (draft: string) => CellEditParse;
		/** Extra class for the open input (e.g. tabular digits). */
		inputClass?: string;
		/** Class for the non-editing value (e.g. truncate, tabular digits). */
		displayClass?: string;
		inputmode?: 'decimal';
	} = $props();

	// `cell`/`save`/`parse` are read through closures so the edit captures the
	// current prop, not its initial value (the same getter contract createCellEdit
	// already requires for `cell`).
	const edit = createCellEdit({
		current: () => (cell.state === 'OK' ? cell.value : undefined),
		save: (value) => save(value),
		parse: (draft) => parse(draft),
	});
</script>

{#if edit.editing}
	<input
		{@attach (node) => node.select()}
		{inputmode}
		bind:value={edit.draft}
		onblur={edit.commit}
		onkeydown={edit.onKeydown}
		class={[
			'w-full rounded border bg-background px-1 py-0.5 text-sm [text-align:inherit] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
			inputClass,
		]}
	/>
{:else}
	<!-- The display reads its alignment from the cell (numerics right-align there),
	     so the open input and the closed value line up without a per-kind class. -->
	<button
		type="button"
		onclick={edit.start}
		class={[
			'block w-full cursor-text rounded-sm px-1 py-0.5 [text-align:inherit] hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
			displayClass,
		]}
	>
		{#if cell.state === 'NEEDS_VALUE'}
			<FieldEmpty />
		{:else}
			<span class="block truncate">{String(cell.value)}</span>
		{/if}
	</button>
{/if}
