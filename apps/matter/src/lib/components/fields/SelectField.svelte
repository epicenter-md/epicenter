<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import type { FieldOf } from '@epicenter/field';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './field-props';

	let { cell, save }: FieldProps<FieldOf<'select'>> = $props();

	// The raw enum literals, NOT stringified: a numeric or boolean enum must save
	// its ORIGINAL typed value. Saving "2" for a `{ enum: [1, 2, 3] }` field would
	// fail the schema and flip the cell to INVALID, so options are keyed by INDEX
	// and mapped back to the literal on change. Indexing also sidesteps a [1, "1"]
	// key collision that stringified values would produce. `cell.field` is the select
	// variant, so `schema.enum` is the typed primitives, never a raw `unknown[]`.
	const values = $derived(cell.field.schema.enum);

	// The Select's value is the option index ('' = no selection). Picking always
	// commits a value; emptying the field back to NEEDS_VALUE is the cell's chrome,
	// not an in-menu item, so this widget only ever saves.
	const selected = $derived.by(() => {
		if (cell.state !== 'OK') return '';
		const i = values.findIndex((value) => Object.is(value, cell.value));
		return i >= 0 ? String(i) : '';
	});
</script>

<Select.Root
	type="single"
	value={selected}
	onValueChange={(value) => save(values[Number(value)])}
>
	<Select.Trigger size="sm" class="w-full">
		{#if cell.state === 'NEEDS_VALUE'}
			<FieldEmpty />
		{:else}
			<span class="truncate">{String(cell.value)}</span>
		{/if}
	</Select.Trigger>
	<Select.Content>
		<Select.Group>
			{#each values as option, i (i)}
				<Select.Item value={String(i)} label={String(option)} />
			{/each}
		</Select.Group>
	</Select.Content>
</Select.Root>
