<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { ClipboardIcon, TrashIcon } from '$lib/components/icons';
	import { Badge } from '@repo/ui/badge';
	import { Button, buttonVariants } from '@repo/ui/button';
	import { Card } from '@repo/ui/card';
	import { Checkbox } from '@repo/ui/checkbox';
	import * as Dialog from '@repo/ui/dialog';
	import * as DropdownMenu from '@repo/ui/dropdown-menu';
	import { Input } from '@repo/ui/input';
	import { Label } from '@repo/ui/label';
	import { Skeleton } from '@repo/ui/skeleton';
	import { SelectAllPopover, SortableTableHeader } from '@repo/ui/table';
	import * as Table from '@repo/ui/table';
	import { Textarea } from '@repo/ui/textarea';
	import { rpc } from '$lib/query';
	import type { Recording } from '$lib/services/db';
	import { cn } from '@repo/ui/utils';
	import { createPersistedState } from '@repo/svelte-utils';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import {
		FlexRender,
		createTable as createSvelteTable,
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
	import {
		ChevronDownIcon,
		EllipsisIcon,
		EllipsisIcon as LoadingTranscriptionIcon,
		RepeatIcon as RetryTranscriptionIcon,
		PlayIcon as StartTranscriptionIcon,
	} from '@lucide/svelte';
	import { nanoid } from 'nanoid/non-secure';
	import { createRawSnippet } from 'svelte';
	import { z } from 'zod';
	import LatestTransformationRunOutputByRecordingId from './LatestTransformationRunOutputByRecordingId.svelte';
	import RenderAudioUrl from './RenderAudioUrl.svelte';
	import TranscribedTextDialog from './TranscribedTextDialog.svelte';
	import { RecordingRowActions } from './row-actions';
	import { format } from 'date-fns';

	/**
	 * Returns a cell renderer for a date/time column using date-fns format.
	 * @param {string} formatString - date-fns format string
	 * @returns {(args: { getValue: () => string }) => string}
	 */
	function formattedCell(formatString: string) {
		return ({ getValue }: { getValue: () => string }) => {
			const value = getValue();
			if (!value) return '';
			const date = new Date(value);
			if (isNaN(date.getTime())) return value;
			try {
				return format(date, formatString);
			} catch {
				return value;
			}
		};
	}

	const getAllRecordingsQuery = createQuery(
		rpc.recordings.getAllRecordings.options,
	);
	const transcribeRecordings = createMutation(
		rpc.transcription.transcribeRecordings.options,
	);
	const deleteRecordings = createMutation(
		rpc.recordings.deleteRecordings.options,
	);
	const copyToClipboard = createMutation(rpc.text.copyToClipboard.options);

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
			id: 'ID',
			accessorKey: 'id',
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
			id: 'Title',
			accessorKey: 'title',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
		},
		{
			id: 'Subtitle',
			accessorKey: 'subtitle',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Subtitle',
				}),
		},
		{
			id: 'Timestamp',
			accessorKey: 'timestamp',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Timestamp',
				}),
			cell: formattedCell(DATE_FORMAT),
		},
		{
			id: 'Created At',
			accessorKey: 'createdAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Created At',
				}),
			cell: formattedCell(DATE_FORMAT),
		},
		{
			id: 'Updated At',
			accessorKey: 'updatedAt',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Updated At',
				}),
			cell: formattedCell(DATE_FORMAT),
		},
		{
			id: 'Transcribed Text',
			accessorKey: 'transcribedText',
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Transcribed Text',
				}),
			cell: ({ getValue, row }) => {
				const transcribedText = getValue<string>();
				if (!transcribedText) return;
				return renderComponent(TranscribedTextDialog, {
					recordingId: row.id,
					transcribedText,
				});
			},
		},
		{
			id: 'Latest Transformation Run Output',
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
			id: 'Audio',
			accessorFn: ({ id, blob }) => ({ id, blob }),
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Audio',
				}),
			cell: ({ getValue }) => {
				const { id, blob } = getValue<Pick<Recording, 'id' | 'blob'>>();
				return renderComponent(RenderAudioUrl, { id, blob });
			},
		},
		{
			id: 'Actions',
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
		onParseError: (error) => [{ id: 'timestamp', desc: true }],
		schema: z.array(z.object({ desc: z.boolean(), id: z.string() })),
	});
	let columnFilters = $state<ColumnFiltersState>([]);
	let columnVisibility = createPersistedState({
		key: 'whispering-recordings-data-table-column-visibility',
		onParseError: (error) => ({
			ID: false,
			Title: false,
			Subtitle: false,
			'Created At': false,
			'Updated At': false,
		}),
		schema: z.record(z.string(), z.boolean()),
	});
	let rowSelection = createPersistedState({
		key: 'whispering-recordings-data-table-row-selection',
		onParseError: (error) => ({}),
		schema: z.record(z.string(), z.boolean()),
	});
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 10 });
	let globalFilter = $state('');

	const table = createSvelteTable({
		getRowId: (originalRow) => originalRow.id,
		get data() {
			return getAllRecordingsQuery.data ?? [];
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

<svelte:head>
	<title>All Recordings</title>
</svelte:head>

<main class="flex w-full flex-1 flex-col gap-2 px-4 py-4 sm:px-8 mx-auto">
	<h1 class="scroll-m=20 text-4xl font-bold tracking-tight lg:text-5xl">
		Recordings
	</h1>
	<p class="text-muted-foreground">
		Your latest recordings and transcriptions, stored locally in IndexedDB.
	</p>
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
					<WhisperingButton
						tooltipContent="Transcribe selected recordings"
						variant="outline"
						size="icon"
						disabled={transcribeRecordings.isPending}
						onclick={() => {
							const toastId = nanoid();
							rpc.notify.loading.execute({
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
											rpc.notify.success.execute({
												id: toastId,
												title: `Transcribed ${n} recording${n === 1 ? '' : 's'}!`,
												description: `Your ${n} recording${n === 1 ? ' has' : 's have'} been transcribed successfully.`,
											});
											return;
										}
										const isAllFailed = oks.length === 0;
										if (isAllFailed) {
											const n = errs.length;
											rpc.notify.error.execute({
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
										rpc.notify.warning.execute({
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
							const currentRow = getAllRecordingsQuery.data?.find((r) => r.id === id);
							return currentRow?.transcriptionStatus === 'TRANSCRIBING';
						})}
							<LoadingTranscriptionIcon class="size-4" />
						{:else if selectedRecordingRows.some(({ id }) => {
							const currentRow = getAllRecordingsQuery.data?.find((r) => r.id === id);
							return currentRow?.transcriptionStatus === 'DONE';
						})}
							<RetryTranscriptionIcon class="size-4" />
						{:else}
							<StartTranscriptionIcon class="size-4" />
						{/if}
					</WhisperingButton>

					<Dialog.Root
						open={isDialogOpen}
						onOpenChange={(v) => (isDialogOpen = v)}
					>
						<Dialog.Trigger>
							<WhisperingButton
								tooltipContent="Copy transcribed text from selected recordings"
								variant="outline"
								size="icon"
							>
								<ClipboardIcon class="size-4" />
							</WhisperingButton>
						</Dialog.Trigger>
						<Dialog.Content>
							<Dialog.Header>
								<Dialog.Title>Copy Transcripts</Dialog.Title>
								<Dialog.Description>
									Make changes to your profile here. Click save when you're
									done.
								</Dialog.Description>
							</Dialog.Header>
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
							<Dialog.Footer>
								<WhisperingButton
									tooltipContent="Copy transcriptions"
									onclick={() => {
										copyToClipboard.mutate(
											{ text: joinedTranscriptionsText },
											{
												onSuccess: () => {
													isDialogOpen = false;
													rpc.notify.success.execute({
														title: 'Copied transcribed texts to clipboard!',
														description: joinedTranscriptionsText,
													});
												},
												onError: (error) => {
													rpc.notify.error.execute({
														title:
															'Error copying transcribed texts to clipboard',
														description: error.message,
														action: { type: 'more-details', error: error },
													});
												},
											},
										);
									}}
									type="submit"
								>
									Copy Transcriptions
								</WhisperingButton>
							</Dialog.Footer>
						</Dialog.Content>
					</Dialog.Root>

					<WhisperingButton
						tooltipContent="Delete selected recordings"
						variant="outline"
						size="icon"
						onclick={() => {
							confirmationDialog.open({
								title: 'Delete recordings',
								subtitle: 'Are you sure you want to delete these recordings?',
								confirmText: 'Delete',
								onConfirm: () => {
									deleteRecordings.mutate(
										selectedRecordingRows.map(({ original }) => original),
										{
											onSuccess: () => {
												rpc.notify.success.execute({
													title: 'Deleted recordings!',
													description:
														'Your recordings have been deleted successfully.',
												});
											},
											onError: (error) => {
												rpc.notify.error.execute({
													title: 'Failed to delete recordings!',
													description: 'Your recordings could not be deleted.',
													action: { type: 'more-details', error: error },
												});
											},
										},
									);
								},
							});
						}}
					>
						<TrashIcon class="size-4" />
					</WhisperingButton>
				{/if}

				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class={cn(
							buttonVariants({ variant: 'outline' }),
							'ml-auto items-center transition-all [&[data-state=open]>svg]:rotate-180',
						)}
					>
						Columns <ChevronDownIcon
							class="ml-2 size-4 transition-transform duration-200"
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						{#each table
							.getAllColumns()
							.filter((c) => c.getCanHide()) as column (column.id)}
							<DropdownMenu.CheckboxItem
								bind:checked={
									() => column.getIsVisible(),
									(value) => column.toggleVisibility(!!value)
								}
							>
								{column.columnDef.id}
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
					{#if getAllRecordingsQuery.isPending}
						{#each { length: 5 }}
							<Table.Row>
								<Table.Cell>
									<Skeleton class="size-4" />
								</Table.Cell>
								<Table.Cell colspan={columns.length - 1}>
									<Skeleton class="h-4 w-full" />
								</Table.Cell>
							</Table.Row>
						{/each}
					{:else if table.getRowModel().rows?.length}
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
							<Table.Cell colspan={columns.length} class="h-24 text-center">
								{#if globalFilter}
									No recordings found.
								{:else}
									No recordings yet. Start recording to add one.
								{/if}
							</Table.Cell>
						</Table.Row>
					{/if}
				</Table.Body>
			</Table.Root>
		</div>

		<div class="flex items-center justify-between">
			<div class="text-muted-foreground text-sm">
				{selectedRecordingRows.length} of {table.getFilteredRowModel().rows
					.length} row(s) selected.
			</div>
			<div class="flex items-center space-x-2">
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
			</div>
		</div>
	</Card>
</main>
