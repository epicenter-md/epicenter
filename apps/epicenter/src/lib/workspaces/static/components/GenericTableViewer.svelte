<script lang="ts">
	import * as Y from 'yjs';
	import * as Card from '@epicenter/ui/card';
	import { Badge } from '@epicenter/ui/badge';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import { readTableRows } from '$lib/yjs/discover';

	type Props = {
		ydoc: Y.Doc;
		tableName: string;
		initialRows: Record<string, unknown>[];
	};

	let { ydoc, tableName, initialRows }: Props = $props();

	// Initialize state with initial data
	let rows = $state(initialRows);

	// Set up Y.Array observer for live updates
	$effect(() => {
		const array = ydoc.getArray(`table:${tableName}`);

		const updateRows = () => {
			rows = readTableRows(ydoc, tableName);
		};

		array.observe(updateRows);

		return () => {
			array.unobserve(updateRows);
		};
	});

	// Derive columns from first row
	const firstRow = $derived(rows[0]);
	const columns = $derived(
		firstRow ? Object.keys(firstRow).filter((k) => k !== 'id') : [],
	);
</script>

<Card.Root>
	<Card.Header class="pb-3">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<TableIcon class="text-muted-foreground size-4" />
				<Card.Title class="text-base">{tableName}</Card.Title>
			</div>
			<Badge variant="secondary">{rows.length} rows</Badge>
		</div>
	</Card.Header>
	<Card.Content>
		{#if rows.length === 0}
			<p class="text-muted-foreground text-sm">No rows</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b">
							<th
								class="text-muted-foreground px-2 py-1.5 text-left font-medium"
								>id</th
							>
							{#each columns as col}
								<th
									class="text-muted-foreground px-2 py-1.5 text-left font-medium"
									>{col}</th
								>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each rows.slice(0, 10) as row (row.id)}
							<tr class="border-b last:border-0">
								<td class="px-2 py-1.5 font-mono text-xs">{row.id}</td>
								{#each columns as col}
									<td class="max-w-xs truncate px-2 py-1.5">
										{#if typeof row[col] === 'object'}
											<code class="text-xs">{JSON.stringify(row[col])}</code>
										{:else}
											{row[col]}
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				{#if rows.length > 10}
					<p class="text-muted-foreground mt-2 text-xs">
						Showing 10 of {rows.length} rows
					</p>
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
