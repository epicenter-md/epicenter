<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import Grid2x2Icon from '@lucide/svelte/icons/grid-2x2';
	import KanbanIcon from '@lucide/svelte/icons/kanban';
	import type { ViewSpec } from '@epicenter/matter-core';
	import { goto } from '$app/navigation';
	import { routes, SWITCH_NAV } from '$lib/routes';
	import BoardView from '$lib/components/BoardView.svelte';
	import TableGrid from '$lib/components/TableGrid.svelte';
	import type { TableHandle } from '$lib/table.svelte';
	import { createTableQuery } from '$lib/table-query.svelte';
	import type { VaultHandle } from '$lib/vault.svelte';

	// One table of the active vault. The Vault constructs and disposes the table (it owns the
	// watcher lifetime) and owns the shared `.matter` mirror the query reads; this pane just
	// renders it. VaultShell keys this component on the active table, so switching tables remounts
	// the pane with a fresh query and its own effect.
	let {
		vault,
		table,
		projection,
	}: {
		vault: VaultHandle;
		table: TableHandle;
		projection?: ViewSpec;
	} = $props();

	// This table's slice of the vault-wide integrity, selected from the one live model the
	// IntegrityPanel also reads, so the grid's reference chips and the panel's findings agree by
	// construction. Derived here, next to the grid that consumes it, rather than threaded from the
	// shell: the pane already holds the vault, so the slice is a pure selector with no prop hop.
	const assessment = $derived(
		vault.integrity.tables.find((t) => t.name === table.folderName),
	);

	// One unified query per pane: it reads the vault's mirror for this table (WHERE filter, full-text
	// match, column sort) and owns its own effect, re-querying on a control or mirror change and
	// cancelling stale runs. The remount-per-table keying is what makes capturing this table's name at
	// construction safe.
	// svelte-ignore state_referenced_locally - VaultShell keys this pane on the active table, so it remounts (not re-renders) when the table changes; capturing the construction-time table is the intent.
	const query = createTableQuery(vault.mirror, () => table.folderName);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await table.whenReady}
		<Loading class="flex-1" label="Loading {table.folderName}" />
	{:then _}
		{#if table.writeError}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
				<Alert.Description class="text-xs">
					Couldn't save: {table.writeError}
				</Alert.Description>
			</Alert.Root>
		{/if}
		{#if table.read.view.mode === 'typed' && table.read.view.contract.views.length}
			<div class="flex min-h-10 items-center gap-1 overflow-x-auto border-b px-3 py-1">
				<button
					type="button"
					aria-current={projection === undefined ? 'true' : undefined}
					onclick={() => goto(routes.table(table.folderName), SWITCH_NAV)}
					class={[
						'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition',
						projection === undefined
							? 'bg-muted font-medium text-foreground'
							: 'text-muted-foreground hover:bg-muted/50',
					]}
				>
					<Grid2x2Icon class="size-4" />
					Grid
				</button>
				{#each table.read.view.contract.views as view (view.id)}
					<button
						type="button"
						aria-current={projection?.id === view.id ? 'true' : undefined}
						onclick={() => goto(routes.projection(table.folderName, view.id), SWITCH_NAV)}
						class={[
							'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition',
							projection?.id === view.id
								? 'bg-muted font-medium text-foreground'
								: 'text-muted-foreground hover:bg-muted/50',
						]}
					>
						<KanbanIcon class="size-4" />
						{view.title ?? view.id}
					</button>
				{/each}
			</div>
		{/if}
		{#if projection}
			<BoardView {table} {projection} {query} />
		{:else}
			<TableGrid {table} {query} {assessment} />
		{/if}
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't watch {table.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
