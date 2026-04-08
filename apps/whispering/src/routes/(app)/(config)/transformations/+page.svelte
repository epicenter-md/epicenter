<script lang="ts">
	import { createPersistedState } from '@epicenter/svelte';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as ButtonGroup from '@epicenter/ui/button-group';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Table from '@epicenter/ui/table';
	import { SelectAllPopover, SortableTableHeader } from '@epicenter/ui/table';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type {
		ColumnDef,
		ColumnFiltersState,
		PaginationState,
	} from '@tanstack/table-core';
	import {
		getCoreRowModel,
		getFilteredRowModel,
		getPaginationRowModel,
		getSortedRowModel,
	} from '@tanstack/table-core';
	import { type } from 'arktype';
	import { createRawSnippet } from 'svelte';
	import OpenFolderButton from '$lib/components/OpenFolderButton.svelte';
	import { PATHS } from '$lib/constants/paths';
	import { rpc } from '$lib/query';
	import {
		type Transformation,
		transformations,
	} from '$lib/state/transformations.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CreateTransformationButton from './CreateTransformationButton.svelte';
	import MarkTransformationActiveButton from './MarkTransformationActiveButton.svelte';
	import TransformationRowActions from './TransformationRowActions.svelte';

	const columns: ColumnDef<Transformation>[] = [
		{
			id: 'select',
			header: ({ table }) =>
				renderComponent(SelectAllPopover<Transformation>, { table }),
			cell: ({ row }) =>
				renderComponent(Checkbox, {
					checked: row.getIsSelected(),
					onCheckedChange: (value) => row.toggleSelected(!!value),
					'aria-label': 'Select row',
				}),
			enableSorting: false,
			enableHiding: false,
		},
		{
			id: 'mark-selected',
			cell: ({ row }) =>
				renderComponent(MarkTransformationActiveButton, {
					transformation: row.original,
					size: 'icon',
				}),
			enableSorting: false,
			enableHiding: false,
		},
		{
			accessorKey: 'id',
			cell: ({ getValue }) =>
				renderComponent(Badge, {
					variant: 'id',
					children: createRawSnippet((_name) => ({
						render: () => getValue<string>(),
					})),
				}),
			header: 'ID',
		},
		{
			accessorKey: 'title',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
		},
		{
			accessorKey: 'description',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Description',
				}),
		},
		{
			id: 'actions',
			accessorFn: (transformation) => transformation,
			header: 'Actions',
			cell: ({ getValue }) => {
				const transformation = getValue<Transformation>();
				return renderComponent(TransformationRowActions, {
					transformationId: transformation.id,
				});
			},
		},
	];

	let sorting = createPersistedState({
		key: 'whispering-transformations-data-table-sorting',
		onParseError: (_error) => [{ id: 'title', desc: false }],
		schema: type({ desc: 'boolean', id: 'string' }).array(),
	});
	let columnFilters = $state<ColumnFiltersState>([]);
	let rowSelection = createPersistedState({
		key: 'whispering-transformations-data-table-row-selection',
		onParseError: (_error) => ({}),
		schema: type('Record<string, boolean>'),
	});
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 10 });
	let globalFilter = $state('');

	const table = createSvelteTable({
		getRowId: (originalRow) => originalRow.id,
		get data() {
			return transformations.sorted;
		},
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		onSortingChange: (updater) => {
			if (typeof updater === 'function') {
				sorting.value = updater(sorting.value);
			} else {
				sorting.value = updater;
			}
		},
		onColumnFiltersChange: (updater) => {
			if (typeof updater === 'function') {
				columnFilters = updater(columnFilters);
			} else {
				columnFilters = updater;
			}
		},
		onRowSelectionChange: (updater) => {
			if (typeof updater === 'function') {
				rowSelection.value = updater(rowSelection.value);
			} else {
				rowSelection.value = updater;
			}
		},
		onPaginationChange: (updater) => {
			if (typeof updater === 'function') {
				pagination = updater(pagination);
			} else {
				pagination = updater;
			}
		},
		onGlobalFilterChange: (updater) => {
			if (typeof updater === 'function') {
				globalFilter = updater(globalFilter);
			} else {
				globalFilter = updater;
			}
		},
		state: {
			get sorting() {
				return sorting.value;
			},
			get columnFilters() {
				return columnFilters;
			},
			get rowSelection() {
				return rowSelection.value;
			},
			get pagination() {
				return pagination;
			},
			get globalFilter() {
				return globalFilter;
			},
		},
	});

	const selectedTransformationRows = $derived(
		table.getFilteredSelectedRowModel().rows,
	);
</script>

<svelte:head> <title>All Transformations</title> </svelte:head>

<main class="flex w-full flex-1 flex-col gap-2 px-4 py-4 sm:px-8 mx-auto">
	<SectionHeader.Root>
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Transformations
		</SectionHeader.Title>
		<SectionHeader.Description>
			Your text transformations, stored locally in IndexedDB.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<div class="flex items-center justify-between gap-2 w-full">
		<Input
			placeholder="Filter transformations..."
			type="text"
			class="w-full"
			bind:value={globalFilter}
		/>
		{#if selectedTransformationRows.length > 0}
			<Button
				tooltip="Delete selected transformations"
				variant="outline"
				size="icon"
				onclick={() => {
					confirmationDialog.open({
						title: 'Delete transformations',
						description:
							'Are you sure you want to delete these transformations?',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => {
							for (const { original } of selectedTransformationRows) {
								transformations.delete(original.id);
							}
							rpc.notify.success({
								title: 'Deleted transformations!',
								description:
									'Your transformations have been deleted successfully.',
							});
						},
					});
				}}
			>
				<TrashIcon class="size-4" />
			</Button>
		{/if}

		<OpenFolderButton
			getFolderPath={PATHS.DB.TRANSFORMATIONS}
			tooltipText="Open transformations folder"
		/>

		<CreateTransformationButton />
	</div>

	<div class="rounded-md border">
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
						<Table.Row
							style="view-transition-name: {viewTransition.transformation(
								row.id,
							)}"
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
							<Empty.Root class="py-8">
								<Empty.Header>
									<Empty.Media variant="icon">
										{#if globalFilter}
											<SearchIcon />
										{:else}
											<WandSparklesIcon />
										{/if}
									</Empty.Media>
									<Empty.Title>
										{#if globalFilter}
											No transformations found
										{:else}
											No transformations yet
										{/if}
									</Empty.Title>
									<Empty.Description>
										{#if globalFilter}
											Try adjusting your search or filters.
										{:else}
											Click "Create Transformation" to add one.
										{/if}
									</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						</Table.Cell>
					</Table.Row>
				{/if}
			</Table.Body>
		</Table.Root>
	</div>

	<div class="flex items-center justify-between">
		<div class="text-muted-foreground text-sm">
			{selectedTransformationRows.length}
			of
			{table.getFilteredRowModel().rows
				.length}
			row(s) selected.
		</div>
		<ButtonGroup.Root>
			<Button
				variant="outline"
				size="sm"
				onclick={() => table.previousPage()}
				disabled={!table.getCanPreviousPage()}
			>
				Previous
			</Button>
			<Button
				variant="outline"
				size="sm"
				onclick={() => table.nextPage()}
				disabled={!table.getCanNextPage()}
			>
				Next
			</Button>
		</ButtonGroup.Root>
	</div>
</main>
