<script lang="ts" generics="TColumn extends Column<any, any>">
	import type { Column } from '@tanstack/svelte-table';

	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpDownIcon from '@lucide/svelte/icons/arrow-up-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';

	import { Button } from '../button/index.js';

	let { column, headerText }: { column: TColumn; headerText: string } =
		$props();
</script>

<Button
	variant="ghost"
	onclick={() => {
		column.toggleSorting();
	}}
>
	{headerText}
	{#if column.getIsSorted() === 'asc'}
		<ArrowUpIcon class="ml-2 size-4" />
	{:else if column.getIsSorted() === 'desc'}
		<ArrowDownIcon class="ml-2 size-4" />
	{:else}
		<ArrowUpDownIcon class="ml-2 size-4" />
	{/if}
</Button>
