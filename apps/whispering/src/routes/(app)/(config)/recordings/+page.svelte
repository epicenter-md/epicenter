<script lang="ts">
	import { createPersistedState } from '@epicenter/svelte';
	import { Badge } from '@epicenter/ui/badge';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as ButtonGroup from '@epicenter/ui/button-group';
	import { Card } from '@epicenter/ui/card';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Table from '@epicenter/ui/table';
	import { SelectAllPopover, SortableTableHeader } from '@epicenter/ui/table';
	import { Textarea } from '@epicenter/ui/textarea';
	import { cn } from '@epicenter/ui/utils';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import LoadingTranscriptionIcon from '@lucide/svelte/icons/ellipsis';
	import MicIcon from '@lucide/svelte/icons/mic';
	import StartTranscriptionIcon from '@lucide/svelte/icons/play';
	import RetryTranscriptionIcon from '@lucide/svelte/icons/repeat';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createMutation } from '@tanstack/svelte-query';
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
	import { format } from 'date-fns';
	import { nanoid } from 'nanoid/non-secure';
	import { createRawSnippet } from 'svelte';
	import TranscriptDialog from '$lib/components/copyable/TranscriptDialog.svelte';
	import OpenFolderButton from '$lib/components/OpenFolderButton.svelte';
	import { PATHS } from '$lib/constants/paths';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { type Recording, recordings } from '$lib/state/recordings.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { recordingActions } from '$lib/utils/recording-actions';
	import LatestTransformationRunOutputByRecordingId from './LatestTransformationRunOutputByRecordingId.svelte';
	import RenderAudioUrl from './RenderAudioUrl.svelte';
	import { RecordingRowActions } from './row-actions';

	/**
	 * Returns a cell renderer for a date/time column using date-fns format.
	 *
	 * @param formatString - date-fns format string
	 */
	function formattedCell(formatString: string) {
		return ({ getValue }: { getValue: () => unknown }) => {
			const value = getValue();
			if (typeof value !== 'string' || !value) return '';
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			try {
				return format(date, formatString);
			} catch {
				return value;
			}
		};
	}

	const transcribeRecordings = createMutation(
		() => rpc.transcription.transcribeRecordings.options,
	);
	const DATE_FORMAT = 'PP p'; // e.g., Aug 13, 2025, 10:00 AM

	const columns: ColumnDef<Recording>[] = [
		{
			id: 'select',
			header: ({ table }) =>
				renderComponent(SelectAllPopover<Recording>, { table }),
			cell: ({ row }) =>
				renderComponent(Checkbox, {
					checked: row.getIsSelected(),
					onCheckedChange: (value) => row.toggleSelected(!!value),
					'aria-label': 'Select row',
				}),
			enableSorting: false,
			enableHiding: false,
			filterFn: (row, _columnId, filterValue) => {
				const title = String(row.getValue('title'));
				const subtitle = String(row.getValue('subtitle'));
				const transcribedText = String(row.getValue('transcribedText'));
				return (
					title.toLowerCase().includes(filterValue.toLowerCase()) ||
					subtitle.toLowerCase().includes(filterValue.toLowerCase()) ||
					transcribedText.toLowerCase().includes(filterValue.toLowerCase())
				);
			},
		},
		{
			accessorKey: 'id',
			meta: { label: 'ID' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, { column, headerText: 'ID' }),
			cell: ({ getValue }) => {
				const id = getValue<string>();
				return renderComponent(Badge, {
					variant: 'id',
					children: createRawSnippet(() => ({
						render: () => id,
					})),
				});
			},
		},
		{
			accessorKey: 'title',
			meta: { label: 'Title' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
		},
		{
			accessorKey: 'subtitle',
			meta: { label: 'Subtitle' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Subtitle',
				}),
		},
		{
			accessorKey: 'timestamp',
			meta: { label: 'Timestamp' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Timestamp',
				}),
			cell: formattedCell(DATE_FORMAT),
		},
		{
			accessorKey: 'createdAt',
			meta: { label: 'Created At' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Created At',
				}),
			cell: formattedCell(DATE_FORMAT),
		},
		{
			accessorKey: 'updatedAt',
			meta: { label: 'Updated At' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Updated At',
				}),
			cell: formattedCell(DATE_FORMAT),
		},
		{
			accessorKey: 'transcribedText',
			meta: { label: 'Transcript' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Transcript',
				}),
			cell: ({ getValue, row }) => {
				const transcribedText = getValue<string>();
				if (!transcribedText) return;
				return renderComponent(TranscriptDialog, {
					recordingId: row.id,
					transcribedText,
					onDelete: () => {
						confirmationDialog.open({
							title: 'Delete recording',
							description: 'Are you sure you want to delete this recording?',
							confirm: { text: 'Delete', variant: 'destructive' },
							onConfirm: () => {
								services.db.recordings.revokeAudioUrl(row.original.id);
								recordings.delete(row.original.id);
								rpc.notify.success({
									title: 'Deleted recording!',
									description: 'Your recording has been deleted.',
								});
							},
						});
					},
				});
			},
		},
		{
			id: 'latestTransformationRunOutput',
			meta: { label: 'Latest Transformation Run Output' },
			accessorFn: ({ id }) => id,
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Latest Transformation Run Output',
				}),
			cell: ({ getValue }) => {
				const recordingId = getValue<string>();
				return renderComponent(LatestTransformationRunOutputByRecordingId, {
					recordingId,
				});
			},
		},
		{
			id: 'audio',
			meta: { label: 'Audio' },
			accessorFn: ({ id }) => id,
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Audio',
				}),
			cell: ({ getValue }) => {
				const id = getValue<string>();
				return renderComponent(RenderAudioUrl, { id });
			},
		},
		{
			id: 'actions',
			meta: { label: 'Actions' },
			accessorFn: (recording) => recording,
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Actions',
				}),
			cell: ({ getValue }) => {
				const recording = getValue<Recording>();
				return renderComponent(RecordingRowActions, {
					recordingId: recording.id,
				});
			},
		},
	];

	let sorting = createPersistedState({
		key: 'whispering-recordings-data-table-sorting',
		onParseError: (_error) => [{ id: 'timestamp', desc: true }],
		schema: type({ desc: 'boolean', id: 'string' }).array(),
	});
	let columnFilters = $state<ColumnFiltersState>([]);
	let columnVisibility = createPersistedState({
		key: 'whispering-recordings-data-table-column-visibility',
		onParseError: (_error) => ({
			id: false,
			title: false,
			subtitle: false,
			createdAt: false,
			updatedAt: false,
		}),
		schema: type('Record<string, boolean>'),
	});
	let rowSelection = createPersistedState({
		key: 'whispering-recordings-data-table-row-selection',
		onParseError: (_error) => ({}),
		schema: type('Record<string, boolean>'),
	});
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 10 });
	let globalFilter = $state('');

	const table = createSvelteTable({
		getRowId: (originalRow) => originalRow.id,
		get data() {
			return recordings.sorted;
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
		onColumnVisibilityChange: (updater) => {
			if (typeof updater === 'function') {
				columnVisibility.value = updater(columnVisibility.value);
			} else {
				columnVisibility.value = updater;
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
			get columnVisibility() {
				return columnVisibility.value;
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

	const selectedRecordingRows = $derived(
		table.getFilteredSelectedRowModel().rows,
	);

	let template = $state('{{timestamp}} {{transcribedText}}');
	let delimiter = $state('\n\n');

	let isDialogOpen = $state(false);

	const joinedTranscriptionsText = $derived.by(() => {
		const transcriptions = selectedRecordingRows
			.map(({ original }) => original)
			.filter((recording) => recording.transcribedText !== '')
			.map((recording) =>
				template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
					if (key in recording) {
						const value = recording[key as keyof Recording];
						return typeof value === 'string' ? value : '';
					}
					return '';
				}),
			);
		return transcriptions.join(delimiter);
	});
</script>

<svelte:head> <title>All Recordings</title> </svelte:head>

<main class="flex w-full flex-1 flex-col gap-2 px-4 py-4 sm:px-8 mx-auto">
	<SectionHeader.Root>
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Recordings
		</SectionHeader.Title>
		<SectionHeader.Description>
			Your latest recordings and transcriptions, stored locally
			{window.__TAURI_INTERNALS__ ? 'on your file system' : 'in IndexedDB'}.
		</SectionHeader.Description>
	</SectionHeader.Root>
	<Card class="flex flex-col gap-4 p-6">
		<div class="flex flex-col md:flex-row items-center justify-between gap-2">
			<Input
				placeholder="Filter transcripts..."
				type="text"
				class="w-full md:max-w-sm"
				bind:value={globalFilter}
			/>
			<div class="flex w-full items-center justify-between gap-2">
				{#if selectedRecordingRows.length > 0}
					<Button
						tooltip="Transcribe selected recordings"
						variant="outline"
						size="icon"
						disabled={transcribeRecordings.isPending}
						onclick={() => {
							const toastId = nanoid();
							rpc.notify.loading({
								id: toastId,
								title: 'Transcribing queries.recordings...',
								description: 'This may take a while.',
							});
							transcribeRecordings.mutate(
								selectedRecordingRows.map(({ original }) => original),
								{
									onSuccess: ({ oks, errs }) => {
										const isAllSuccessful = errs.length === 0;
										if (isAllSuccessful) {
											const n = oks.length;
											rpc.notify.success({
												id: toastId,
												title: `Transcribed ${n} recording${n === 1 ? '' : 's'}!`,
												description: `Your ${n} recording${n === 1 ? ' has' : 's have'} been transcribed successfully.`,
											});
											return;
										}
										const isAllFailed = oks.length === 0;
										if (isAllFailed) {
											const n = errs.length;
											rpc.notify.error({
												id: toastId,
												title: `Failed to transcribe ${n} recording${n === 1 ? '' : 's'}`,
												description:
													n === 1
														? 'Your recording could not be transcribed.'
														: 'None of your recordings could be transcribed.',
												action: { type: 'more-details', error: errs },
											});
											return;
										}
										// Mixed results
										rpc.notify.warning({
											id: toastId,
											title: `Transcribed ${oks.length} of ${oks.length + errs.length} recordings`,
											description: `${oks.length} succeeded, ${errs.length} failed.`,
											action: { type: 'more-details', error: errs },
										});
									},
								},
							);
						}}
					>
						{#if transcribeRecordings.isPending}
							<EllipsisIcon class="size-4" />
						{:else if selectedRecordingRows.some(({ id }) => {
							const currentRow = recordings.get(id);
							return currentRow?.transcriptionStatus === 'TRANSCRIBING';
						})}
							<LoadingTranscriptionIcon class="size-4" />
						{:else if selectedRecordingRows.some(({ id }) => {
							const currentRow = recordings.get(id);
							return currentRow?.transcriptionStatus === 'DONE';
						})}
							<RetryTranscriptionIcon class="size-4" />
						{:else}
							<StartTranscriptionIcon class="size-4" />
						{/if}
					</Button>

					<Modal.Root
						open={isDialogOpen}
						onOpenChange={(v) => (isDialogOpen = v)}
					>
						<Modal.Trigger>
							<Button
								tooltip="Copy transcripts from selected recordings"
								variant="outline"
								size="icon"
							>
								<CopyIcon class="size-4" />
							</Button>
						</Modal.Trigger>
						<Modal.Content>
							<Modal.Header>
								<Modal.Title>Copy Transcripts</Modal.Title>
								<Modal.Description>
									Make changes to your profile here. Click save when you're
									done.
								</Modal.Description>
							</Modal.Header>
							<div class="grid gap-4 py-4">
								<div class="grid grid-cols-4 items-center gap-4">
									<Label for="template" class="text-right">Template</Label>
									<Textarea
										id="template"
										bind:value={template}
										class="col-span-3"
									/>
								</div>
								<div class="grid grid-cols-4 items-center gap-4">
									<Label for="delimiter" class="text-right">Delimiter</Label>
									<Textarea
										id="delimiter"
										bind:value={delimiter}
										class="col-span-3"
									/>
								</div>
							</div>
							<Textarea
								placeholder="Preview of copied text"
								readonly
								class="h-32"
								value={joinedTranscriptionsText}
							/>
							<Modal.Footer>
								<CopyButton
									text={joinedTranscriptionsText}
									copyFn={createCopyFn('transcripts')}
									size="default"
									onCopy={(status) => {
										if (status === 'success') isDialogOpen = false;
									}}
								>
									Copy Transcriptions
								</CopyButton>
							</Modal.Footer>
						</Modal.Content>
					</Modal.Root>

					<Button
						tooltip="Delete selected recordings"
						variant="outline"
						size="icon"
						onclick={() =>
						recordingActions.deleteWithConfirmation(
							selectedRecordingRows.map(({ original }) => original),
						)}
					>
						<TrashIcon class="size-4" />
					</Button>
				{/if}

				<OpenFolderButton
					getFolderPath={PATHS.DB.RECORDINGS}
					tooltipText="Open recordings folder"
				/>

				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class={cn(
							buttonVariants({ variant: 'outline' }),
							'ml-auto items-center transition-all [&[data-state=open]>svg]:rotate-180',
						)}
					>
						Columns
						<ChevronDownIcon class="size-4 transition-transform duration-200" />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						{#each table
							.getAllColumns()
							.filter((c) => c.getCanHide()) as column (column.id)}
							<DropdownMenu.CheckboxItem
								bind:checked={() => column.getIsVisible(),
									(value) => column.toggleVisibility(!!value)}
							>
								{(column.columnDef.meta as { label?: string })?.label ?? column.id}
							</DropdownMenu.CheckboxItem>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
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
							<Table.Row>
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
												<MicIcon />
											{/if}
										</Empty.Media>
										<Empty.Title>
											{#if globalFilter}
												No recordings found
											{:else}
												No recordings yet
											{/if}
										</Empty.Title>
										<Empty.Description>
											{#if globalFilter}
												Try adjusting your search or filters.
											{:else}
												Start recording to add one.
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
				{selectedRecordingRows.length}
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
	</Card>
</main>
