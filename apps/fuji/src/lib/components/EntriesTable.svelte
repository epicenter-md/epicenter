<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Table from '@epicenter/ui/table';
	import { SortableTableHeader } from '@epicenter/ui/table';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type { ColumnDef } from '@tanstack/table-core';
	import {
		getCoreRowModel,
		getFilteredRowModel,
		getSortedRowModel,
	} from '@tanstack/table-core';
	import { formatDistanceToNowStrict } from 'date-fns';
	import type { Entry, EntryId } from '$lib/workspace';
	import BadgeList from './BadgeList.svelte';

	let {
		entries,
		searchQuery,
		selectedEntryId,
		onSelectEntry,
		onAddEntry,
	}: {
		entries: Entry[];
		searchQuery: string;
		selectedEntryId: EntryId | null;
		onSelectEntry: (id: EntryId) => void;
		onAddEntry: () => void;
	} = $props();

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}

	function relativeTime(dts: string): string {
		try {
			return formatDistanceToNowStrict(parseDateTime(dts), {
				addSuffix: true,
			});
		} catch {
			return dts;
		}
	}

	const columns: ColumnDef<Entry>[] = [
		{
			id: 'title',
			accessorKey: 'title',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
			cell: ({ getValue }) => {
				const title = getValue<string>();
				return title || 'Untitled';
			},
		},
		{
			id: 'subtitle',
			accessorKey: 'subtitle',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Subtitle',
				}),
			cell: ({ getValue }) => {
				const subtitle = getValue<string>();
				return subtitle || '';
			},
		},
		{
			id: 'type',
			accessorKey: 'type',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Type',
				}),
			cell: ({ getValue }) => {
				const types = getValue<string[]>();
				if (!types.length) return '';
				return renderComponent(BadgeList, { items: types });
			},
			enableSorting: false,
		},
		{
			id: 'tags',
			accessorKey: 'tags',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Tags',
				}),
			cell: ({ getValue }) => {
				const tags = getValue<string[]>();
				if (!tags.length) return '';
				return renderComponent(BadgeList, { items: tags });
			},
			enableSorting: false,
		},
		{
			id: 'createdAt',
			accessorKey: 'createdAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Created',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
		{
			id: 'updatedAt',
			accessorKey: 'updatedAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Updated',
				}),
			cell: ({ getValue }) => relativeTime(getValue<string>()),
		},
	];

	let sorting = $state([{ id: 'updatedAt', desc: true }]);

	const table = createSvelteTable({
		getRowId: (row) => row.id,
		get data() {
			return entries;
		},
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onSortingChange: (updater) => {
			if (typeof updater === 'function') {
				sorting = updater(sorting);
			} else {
				sorting = updater;
			}
		},
		state: {
			get sorting() {
				return sorting;
			},
			get globalFilter() {
				return searchQuery;
			},
		},
		globalFilterFn: (row, _columnId, filterValue) => {
			const title = String(row.getValue('title')).toLowerCase();
			const filter = filterValue.toLowerCase();
			return title.includes(filter);
		},
	});
</script>

<div class="flex h-full flex-col">
	<!-- Toolbar -->
	<div class="flex items-center justify-between border-b px-4 py-3">
		<h2 class="text-sm font-semibold">Entries</h2>
		<Button variant="ghost" size="icon" class="size-7" onclick={onAddEntry}>
			<PlusIcon class="size-4" />
		</Button>
	</div>

	<!-- Table -->
	<div class="flex-1 overflow-auto">
		<Table.Root>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup}
					<Table.Row>
						{#each headerGroup.headers as header}
							<Table.Head colspan={header.colSpan}>
								{#if !header.isPlaceholder}
									<FlexRender
										content={header.column.columnDef.header}
										context={header.getContext()}
									/>
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#if table.getRowModel().rows?.length}
					{#each table.getRowModel().rows as row (row.id)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<Table.Row
							class="cursor-pointer transition-colors hover:bg-accent/50 {selectedEntryId === row.id
								? 'bg-accent'
								: ''}"
							onclick={() => onSelectEntry(row.original.id)}
						>
							{#each row.getVisibleCells() as cell}
								<Table.Cell>
									<FlexRender
										content={cell.column.columnDef.cell}
										context={cell.getContext()}
									/>
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				{:else}
					<Table.Row>
						<Table.Cell colspan={columns.length}>
							<div
								class="flex items-center justify-center py-8 text-muted-foreground"
							>
								<p class="text-sm">
									{#if searchQuery}
										No entries match your search.
									{:else}
										No entries yet. Click + to create one.
									{/if}
								</p>
							</div>
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</div>
</div>
