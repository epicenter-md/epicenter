<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
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
	let moveAnnouncement = $state('');

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

	function moveCard(card: BoardCard, columnValue: string | null): boolean {
		if (groupByField === undefined) return false;
		const edit = boardDropEditFor({ card, groupByField, columnValue });
		if (!edit) return false;
		moveAnnouncement = `Moving ${edit.fileName} to ${columnValue ?? 'Unassigned'}.`;
		void table.saveField(edit.fileName, edit.key, edit.value);
		return true;
	}

	function drop(event: DragEvent, columnValue: string | null): void {
		const card = draggedCard;
		draggedCard = undefined;
		if (!card || !moveCard(card, columnValue)) return;
		event.preventDefault();
	}

	function moveCardWithKeyboard(
		event: KeyboardEvent,
		card: BoardCard,
		columnValue: string | null,
	): void {
		const direction =
			event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
		if (direction === 0) return;

		const currentIndex = columns.findIndex(
			(column) => column.value === columnValue,
		);
		for (
			let index = currentIndex + direction;
			index >= 0 && index < columns.length;
			index += direction
		) {
			const target = columns[index]!.value;
			if (!canDropOn(target) || !moveCard(card, target)) continue;
			event.preventDefault();
			return;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<p class="sr-only" role="status" aria-live="polite">{moveAnnouncement}</p>
	<header class="flex items-center gap-2 border-b px-3 py-2">
		<Badge variant="secondary">{cardCount} rows</Badge>
		<Badge variant="secondary">grouped by {projection.groupBy}</Badge>
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
							<Badge variant="secondary">
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
									<Item.Root
										variant="outline"
										size="sm"
										role="listitem"
										tabindex={0}
										aria-label="{card.row.fileName}, {column.value ?? 'Unassigned'}. Use Left or Right arrow to move."
										aria-keyshortcuts="ArrowLeft ArrowRight"
										draggable={true}
										data-board-card={card.row.fileName}
										ondragstart={(event) => dragStart(event, card)}
										onkeydown={(event) => moveCardWithKeyboard(event, card, column.value)}
										class="cursor-grab items-stretch active:cursor-grabbing"
									>
										<Item.Content class="min-w-0">
											<Item.Title
												class="truncate font-mono"
												title={card.row.fileName}
											>
												{card.row.fileName}
											</Item.Title>
											{#if card.fields.length}
												<dl class="mt-2 space-y-2">
													{#each card.fields as cardField (cardField.field.name)}
														<div class="min-w-0">
															<dt
																class="truncate text-xs font-medium uppercase text-muted-foreground"
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
										</Item.Content>
									</Item.Root>
								{/each}
							{/if}
						</div>
					</section>
				{/each}
			</div>
		</div>
	{/if}
</div>
