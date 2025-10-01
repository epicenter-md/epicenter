<script lang="ts" generics="TData">
	import type { Table } from '@tanstack/svelte-table';

	import { Checkbox } from '../checkbox';
	import * as DropdownMenu from '../dropdown-menu';

	let { table }: { table: Table<TData> } = $props();

	const currentPageCount = $derived(table.getRowModel().rows.length);
	const totalRowCount = $derived(table.getCoreRowModel().rows.length);

	const isSomeRowsSelected = $derived(
		table.getSelectedRowModel().rows.length > 0,
	);
</script>

{#if table.getPageCount() > 1}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class="flex items-center gap-2"
			aria-label="Selection options"
		>
			<Checkbox
				checked={table.getIsAllRowsSelected()}
				indeterminate={isSomeRowsSelected && !table.getIsAllRowsSelected()}
				aria-label="Selection options"
			/>
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start">
			{#if !table.getIsAllPageRowsSelected() || table.getIsAllRowsSelected()}
				<DropdownMenu.Item
					onclick={() => {
						table.toggleAllRowsSelected(false);
						table.toggleAllPageRowsSelected(true);
					}}
				>
					Select this page ({currentPageCount} items)
				</DropdownMenu.Item>
			{/if}
			{#if !table.getIsAllRowsSelected()}
				<DropdownMenu.Item
					onclick={() => {
						table.toggleAllRowsSelected(true);
					}}
				>
					Select all ({totalRowCount} items)
				</DropdownMenu.Item>
			{/if}
			{#if isSomeRowsSelected}
				<DropdownMenu.Item
					onclick={() => {
						table.toggleAllRowsSelected(false);
						table.toggleAllPageRowsSelected(false);
					}}
				>
					Clear selection
				</DropdownMenu.Item>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{:else}
	<Checkbox
		bind:checked={
			() => table.getIsAllPageRowsSelected(),
			(value) => table.toggleAllPageRowsSelected(!!value)
		}
		indeterminate={isSomeRowsSelected && !table.getIsAllPageRowsSelected()}
		aria-label="Select all"
	/>
{/if}
