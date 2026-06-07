<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import type { FieldOf } from '@epicenter/field';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './field-props';

	// One option literal, derived from the field's OWN schema (an element of the enum
	// array) so this widget needs no shared primitive type: the option set lives on the
	// schema it already reads.
	type Option = FieldOf<'multiSelect'>['schema']['items']['enum'][number];

	// The plural SelectField: a closed enum set picked from a Popover + Command list,
	// selections shown as Badge chips in the trigger. Pins `FieldOf<'multiSelect'>`
	// because the body reads the SCHEMA (`schema.items.enum` is the option set), the same
	// "reads its schema" signal SelectField carries. The picker stays open across toggles
	// (no `closeAndFocusTrigger`), which is the one behavioral difference from the
	// single-value combobox.
	let { cell, save }: FieldProps<FieldOf<'multiSelect'>> = $props();

	const combobox = useCombobox();

	// The closed options: raw enum literals, NOT stringified. A numeric or boolean option
	// must save its ORIGINAL typed value (saving "2" for `{enum:[1,2,3]}` would fail the
	// schema and flip the cell to INVALID), so the literal rides in the toggle closure and
	// `String(option)` is for display + search only. Same discipline as SelectField.
	const options = $derived(cell.field.schema.items.enum);

	// An OK list cell is always an array; default empty so the picker stays usable when
	// the cell is empty (NEEDS_VALUE) or every option has been deselected.
	const selected = $derived(
		cell.state === 'OK' && Array.isArray(cell.value) ? cell.value : [],
	);
	const has = (option: Option) =>
		selected.some((value) => Object.is(value, option));

	// Toggle by recomputing from option order: keep an option if it is the toggled one and
	// was NOT selected (add it), or another option that WAS selected. So the committed
	// array stays in the field's declared option order and is deduped. Deselecting the
	// last option commits `[]`, a present but empty value (the same way an empty string
	// is a present value), not a clear: deleting the key is the cell's chrome. A
	// `minItems:1` schema rejects `[]` as INVALID, the same as any other failing value.
	function toggle(option: Option) {
		const added = !has(option);
		const next = options.filter((o) => (Object.is(o, option) ? added : has(o)));
		save(next);
	}
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				role="combobox"
				aria-expanded={combobox.open}
				class="h-auto min-h-8 w-full justify-between gap-2 font-normal"
			>
				{#if cell.state === 'NEEDS_VALUE'}
					<FieldEmpty />
				{:else if selected.length === 0}
					<span class="text-muted-foreground">Select...</span>
				{:else}
					<span class="flex flex-wrap gap-1">
						{#each selected as item (String(item))}
							<Badge variant="secondary" class="max-w-[12rem] truncate">
								{String(item)}
							</Badge>
						{/each}
					</span>
				{/if}
				<ChevronsUpDownIcon class="size-4 shrink-0 opacity-50" />
			</Button>
		{/snippet}
	</Popover.Trigger>

	<Popover.Content
		align="start"
		class="w-[--bits-popover-anchor-width] min-w-[14rem] p-0"
	>
		<Command.Root>
			<Command.Input placeholder="Search options..." />
			<Command.List>
				<Command.Empty>No options.</Command.Empty>
				{#each options as option (String(option))}
					<Command.Item value={String(option)} onSelect={() => toggle(option)}>
						<CheckIcon
							class={[
								'size-4 shrink-0',
								has(option) ? 'opacity-100' : 'opacity-0',
							]}
						/>
						<span class="truncate">{String(option)}</span>
					</Command.Item>
				{/each}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
