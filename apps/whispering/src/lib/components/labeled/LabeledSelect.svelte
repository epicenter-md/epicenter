<script
	lang="ts"
	generics="TItem extends { value: string; label: string; disabled?: boolean }"
>
	import { Label } from '@repo/ui/label';
	import * as Select from '@repo/ui/select';
	import { cn } from '@repo/ui/utils';
	import type { Snippet } from 'svelte';

	type T = TItem['value'];

	let {
		id,
		label,
		items = [],
		selected = $bindable(),
		placeholder = 'Select an option',
		class: className,
		disabled = false,
		hideLabel = false,
		description,
		renderOption = defaultRenderOption,
		actionSlot,
	}: {
		id: string;
		label: string;
		items: TItem[];
		selected: T;
		placeholder?: string;
		class?: string;
		disabled?: boolean;
		hideLabel?: boolean;
		description?: string | Snippet;
		/**
		 * Custom snippet for rendering select option content.
		 * Receives an item object and should return the desired display.
		 * If not provided, defaults to showing the item's label.
		 */
		renderOption?: Snippet<[{ item: TItem }]>;
		/**
		 * Optional snippet for rendering an action button (e.g., reset) next to the select.
		 */
		actionSlot?: Snippet;
	} = $props();

	const selectedLabel = $derived(
		items.find((item) => item.value === selected)?.label,
	);
</script>

{#snippet defaultRenderOption({ item }: { item: TItem })}
	{item.label}
{/snippet}

<div class="flex flex-col gap-2">
	<Label class={cn('text-sm', hideLabel && 'sr-only')} for={id}>
		{label}
	</Label>
	<div class="flex items-center gap-2">
		<Select.Root
			type="single"
			{items}
			bind:value={() => selected, (value) => (selected = value)}
			{disabled}
		>
			<Select.Trigger class={cn('w-full flex-1', className)}>
				{selectedLabel ?? placeholder}
			</Select.Trigger>
			<Select.Content>
				{#each items as item}
					<Select.Item
						value={item.value}
						label={item.label}
						disabled={item.disabled}
					>
						{@render renderOption({ item })}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		{@render actionSlot?.()}
	</div>
	{#if description}
		<div class="text-muted-foreground text-sm">
			{#if typeof description === 'string'}
				{description}
			{:else}
				{@render description()}
			{/if}
		</div>
	{/if}
</div>
