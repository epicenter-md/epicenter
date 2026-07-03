<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		resolveVaultSurface,
		routes,
		SWITCH_NAV,
		TABLE_PARAM,
		type VaultPanel,
	} from '$lib/routes';
	import { createVault } from '$lib/vault.svelte';
	import DatabaseTab from './DatabaseTab.svelte';
	import IntegrityPanel from './IntegrityPanel.svelte';
	import SqlConsole from './SqlConsole.svelte';
	import TablePane from './TablePane.svelte';

	let { root }: { root: string } = $props();

	// This keyed component IS the live vault for the active route: construct on mount, dispose on
	// destroy. The route's `{#key data.root}` tears this instance down and builds a fresh one when
	// the active vault changes, so the root watch AND every composed table watch ride this
	// component's lifetime, with no module singleton driving them.
	// svelte-ignore state_referenced_locally - the route keys this component on root, so it remounts (not re-renders) when the active vault changes; capturing the initial root here is the intent.
	const vault = createVault(root);
	$effect(() => () => vault.dispose());

	// Which table is active in the shell, addressed by folder NAME in the URL (`?table=`) so the
	// selection survives a refresh or a shared link and lives in the one place navigation belongs.
	// It is a selection over the always-live table set, not a resource with its own lifecycle (the
	// vault watches every table for cross-table integrity), so a query param fits: VaultShell stays
	// the vault's single owner and does not remount when the table changes. A missing, renamed, or
	// not-yet-loaded name falls through to the first table below, so no URL cleanup is needed.
	const activeName = $derived(page.url.searchParams.get(TABLE_PARAM) ?? undefined);
	const activeTable = $derived(
		vault.tables.find((table) => table.folderName === activeName) ??
			vault.tables[0],
	);

	// The rendered vault surface: a vault-wide panel from `?panel`, a table-scoped projection from
	// `?view`, or the default grid. A resolved projection renders through BoardView (see TablePane);
	// the grid stays the default surface when no projection is selected.
	const activeSurface = $derived(
		resolveVaultSurface(page.url.searchParams, activeTable?.read.view),
	);

	// Opening a panel keeps `?table` so the console defaults to the table you were on (the Database
	// panel is table-agnostic, so it just ignores it). `?panel` owns vault-wide panels; `?view` is
	// reserved for table-scoped projections.
	function panelHref(panel: VaultPanel): string {
		return routes.panel(panel, activeTable?.folderName);
	}

	// Adopt the root as a table (writes the `{}` marker). The watcher re-scans on the new marker and
	// surfaces the table live, so success needs no manual refresh; only a write failure shows here.
	let adopting = $state(false);
	let adoptError = $state<string | undefined>(undefined);
	async function adopt(): Promise<void> {
		adopting = true;
		adoptError = undefined;
		try {
			await vault.adopt();
		} catch (error) {
			adoptError = error instanceof Error ? error.message : String(error);
		} finally {
			adopting = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await vault.whenReady}
		<Loading class="flex-1" label="Loading {vault.folderName}" />
	{:then _}
		<!-- No tables means this folder is not marked and has no marked children (ADR-0029): matter is
		     a declared store, so it shows nothing until a folder is adopted. Offer to adopt the root
		     (write a `{}` marker); the watcher then surfaces it as an untyped table live. -->
		{#if vault.tables.length === 0}
			<Empty.Root class="flex-1 border-0">
				<Empty.Media variant="icon"><LayersIcon /></Empty.Media>
				<Empty.Title>Not a table yet</Empty.Title>
				<Empty.Description>
					{vault.folderName} has no matter.json, so matter shows nothing here. Adopt it to
					create an untyped table from the markdown already inside, or add a matter.json
					yourself.
				</Empty.Description>
				<Empty.Content>
					<Button onclick={adopt} disabled={adopting}>
						<LayersIcon />
						{adopting ? 'Adopting...' : 'Adopt this folder as a table'}
					</Button>
					{#if adoptError}
						<p class="text-sm text-destructive">{adoptError}</p>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{:else}
			<div class="flex min-h-10 items-center gap-1 border-b px-2 py-1">
				<div class="flex flex-1 items-center gap-1 overflow-x-auto">
					{#each vault.tables as table (table.folderName)}
						{@const active =
							activeSurface.kind !== 'panel' &&
							activeTable?.folderName === table.folderName}
						<button
							type="button"
							aria-current={active ? 'true' : undefined}
							onclick={() => goto(routes.table(table.folderName), SWITCH_NAV)}
							class={[
								'shrink-0 rounded-md px-2.5 py-1 text-sm transition',
								active
									? 'bg-muted font-medium text-foreground'
									: 'text-muted-foreground hover:bg-muted/50',
							]}
						>
							{table.folderName}
						</button>
					{/each}
				</div>
				<!-- The two vault-wide views, set off from the per-table tabs: SQL is the query face, the
				     Database panel is the "this is a SQLite database" face. -->
				<div class="flex shrink-0 items-center gap-1 border-l pl-1">
					<button
						type="button"
						aria-current={activeSurface.kind === 'panel' &&
						activeSurface.panel === 'sql'
							? 'true'
							: undefined}
						onclick={() => goto(panelHref('sql'), SWITCH_NAV)}
						class={[
							'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition',
							activeSurface.kind === 'panel' && activeSurface.panel === 'sql'
								? 'bg-muted font-medium text-foreground'
								: 'text-muted-foreground hover:bg-muted/50',
						]}
					>
						<TerminalIcon class="size-4" />
						SQL
					</button>
					<button
						type="button"
						aria-current={activeSurface.kind === 'panel' &&
						activeSurface.panel === 'db'
							? 'true'
							: undefined}
						onclick={() => goto(panelHref('db'), SWITCH_NAV)}
						class={[
							'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition',
							activeSurface.kind === 'panel' && activeSurface.panel === 'db'
								? 'bg-muted font-medium text-foreground'
								: 'text-muted-foreground hover:bg-muted/50',
						]}
					>
						<DatabaseIcon class="size-4" />
						Database
					</button>
				</div>
			</div>
			{#if activeSurface.kind === 'panel' && activeSurface.panel === 'sql'}
				<SqlConsole {vault} defaultTable={activeTable?.folderName} />
			{:else if activeSurface.kind === 'panel' && activeSurface.panel === 'db'}
				<DatabaseTab {vault} />
			{:else if activeTable}
				{#key activeTable}
					<TablePane
						{vault}
						table={activeTable}
						projection={activeSurface.kind === 'projection'
							? activeSurface.projection
							: undefined}
					/>
				{/key}
			{/if}
			<IntegrityPanel integrity={vault.integrity} />
		{/if}
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't open {vault.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
