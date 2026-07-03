<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Empty from '@epicenter/ui/empty';
	import KanbanIcon from '@lucide/svelte/icons/kanban';
	import type { ViewSpec } from '@epicenter/matter-core';
	import type { TableView } from '$lib/table.svelte';
	import type { TableQuery } from '$lib/table-query.svelte';
	import {
		type BoardCard,
		boardColumnsFor,
		boardDropEditFor,
		canWriteBoardColumn,
	} from './board';
	import FieldValue from './FieldValue.svelte';

	let {
		table,
		projection,
		query,
	}: {
		table: TableView;
		projection: ViewSpec;
		query?: TableQuery;
	} = $props();

	const read = $derived(table.read);
	const view = $derived(read.view);
	const groupByField = $derived(
		view.mode === 'typed'
			? view.contract.fields.find((field) => field.name === projection.groupBy)
			: undefined,
	);
	const columns = $derived.by(() => {
		if (view.mode !== 'typed') return [];
		return boardColumnsFor({
			conformance: view.conformance,
			fields: view.contract.fields,
			projection,
			orderedStems: query?.orderedStems,
		});
	});
	const cardCount = $derived(
		columns.reduce((count, column) => count + column.cards.length, 0),
	);

	// The card being dragged, held in state rather than serialized through the drag
	// payload: it is a card this board just rendered, so its identity never leaves the
	// process and `drop` acts on a trusted card, not an arbitrary browser payload.
	let draggedCard = $state<BoardCard>();

	function canDropOn(columnValue: string | null): boolean {
		return (
			groupByField !== undefined &&
			canWriteBoardColumn(groupByField, columnValue)
		);
	}

	function dragStart(event: DragEvent, card: BoardCard): void {
		draggedCard = card;
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function dragOver(event: DragEvent, columnValue: string | null): void {
		if (!canDropOn(columnValue)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	}

	function drop(event: DragEvent, columnValue: string | null): void {
		const card = draggedCard;
		draggedCard = undefined;
		if (!card || groupByField === undefined) return;
		const edit = boardDropEditFor({ card, groupByField, columnValue });
		if (!edit) return;
		event.preventDefault();
		void table.saveField(edit.fileName, edit.key, edit.value);
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<header
		class="flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3"
	>
		<div class="min-w-0">
			<h1 class="max-w-[70vw] truncate text-sm font-semibold">
				{projection.title ?? projection.id}
			</h1>
			<div class="mt-1 flex flex-wrap gap-1.5">
				<Badge variant="secondary">{cardCount} rows</Badge>
				<Badge variant="secondary">grouped by {projection.groupBy}</Badge>
				{#if read.unreadable.length}
					<Badge variant="destructive">{read.unreadable.length} unreadable</Badge>
				{/if}
			</div>
		</div>
		<Badge variant="outline">board</Badge>
	</header>

	{#if columns.length === 0}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><KanbanIcon /></Empty.Media>
			<Empty.Title>No board columns</Empty.Title>
			<Empty.Description>
				Add rows with {projection.groupBy} values to see them on this board.
			</Empty.Description>
		</Empty.Root>
	{:else}
		<div class="flex-1 overflow-auto bg-muted/20">
			<div class="flex min-h-full w-max gap-3 p-3">
				{#each columns as column (column.value ?? '__unassigned__')}
					<section
						class={[
							'flex max-h-full w-72 shrink-0 flex-col rounded-md border bg-background',
							canDropOn(column.value) ? 'border-border' : 'border-border/60',
						]}
					>
						<header class="flex items-center justify-between gap-2 border-b px-3 py-2">
							<h2 class="truncate text-sm font-medium">
								{column.value ?? 'Unassigned'}
							</h2>
							<Badge
								variant="secondary"
								class="h-5 min-w-5 justify-center rounded-md px-1.5 font-mono text-[11px]"
							>
								{column.cards.length}
							</Badge>
						</header>
						<div
							role="list"
							aria-label="{column.value ?? 'Unassigned'} rows"
							data-board-column={column.value ?? '__unassigned__'}
							ondragover={(event) => dragOver(event, column.value)}
							ondrop={(event) => drop(event, column.value)}
							class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
						>
							{#if column.cards.length === 0}
								<p class="px-1 py-6 text-center text-xs text-muted-foreground">
									No rows
								</p>
							{:else}
								{#each column.cards as card (card.row.fileName)}
									<article
										role="listitem"
										draggable={true}
										data-board-card={card.row.fileName}
										ondragstart={(event) => dragStart(event, card)}
										class="cursor-grab rounded-md border bg-card p-3 shadow-sm active:cursor-grabbing"
									>
										<h3
											class="truncate font-mono text-xs font-medium text-card-foreground"
											title={card.row.fileName}
										>
											{card.row.fileName}
										</h3>
										{#if card.fields.length}
											<dl class="mt-2 space-y-2">
												{#each card.fields as cardField (cardField.field.name)}
													<div class="min-w-0">
														<dt
															class="truncate text-[11px] font-medium uppercase text-muted-foreground"
														>
															{cardField.field.name}
														</dt>
														<dd class="mt-0.5 min-w-0 text-sm">
															<FieldValue
																kind={cardField.field.kind}
																value={cardField.value}
															/>
														</dd>
													</div>
												{/each}
											</dl>
										{/if}
									</article>
								{/each}
							{/if}
						</div>
					</section>
				{/each}
			</div>
		</div>
	{/if}
</div>
