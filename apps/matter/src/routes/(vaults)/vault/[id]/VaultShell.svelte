<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import Grid2x2Icon from '@lucide/svelte/icons/grid-2x2';
	import KanbanIcon from '@lucide/svelte/icons/kanban';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		resolveVaultSurface,
		routes,
		SWITCH_NAV,
		TABLE_PARAM,
	} from '$lib/routes';
	import { createVault } from '$lib/vault.svelte';
	import DatabaseTab from './DatabaseTab.svelte';
	import IntegritySheet from './IntegritySheet.svelte';
	import MatterSidebar from './MatterSidebar.svelte';
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

	const isNarrow = new MediaQuery('(max-width: 899px)');
	let sidebarOpen = $state(true);
	$effect(() => {
		sidebarOpen = !isNarrow.current;
	});

	const surfaceTitle = $derived.by(() => {
		if (activeSurface.kind === 'panel') {
			return activeSurface.panel === 'sql' ? 'SQL console' : 'Database';
		}
		if (activeSurface.kind === 'projection') {
			return activeSurface.projection.title ?? activeSurface.projection.id;
		}
		return activeTable?.folderName ?? vault.folderName;
	});

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

<a
	href="#matter-main"
	class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:ring-2 focus:ring-ring"
>
	Skip to workspace
</a>
<Sidebar.Provider bind:open={sidebarOpen} class="min-h-0 flex-1 overflow-hidden">
		<MatterSidebar
			tables={vault.tables}
			{activeTable}
			{activeSurface}
			collapseOnNavigate={isNarrow.current}
		/>
		<Sidebar.Inset id="matter-main" tabindex={-1} class="min-h-0 overflow-hidden">
			<header class="flex min-h-12 items-center gap-2 border-b px-3">
				<Sidebar.Trigger class="shrink-0" />
				<h1
					class={[
						'min-w-0 truncate text-sm font-semibold',
						activeTable && activeSurface.kind !== 'panel' ? 'max-w-40 shrink-0' : 'flex-1',
					]}
				>
					{surfaceTitle}
				</h1>
				{#if activeTable && activeSurface.kind !== 'panel'}
					<nav aria-label="Table views" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
						<Button
							variant={activeSurface.kind === 'grid' ? 'secondary' : 'ghost'}
							size="xs"
							aria-current={activeSurface.kind === 'grid' ? 'page' : undefined}
							onclick={() => goto(routes.table(activeTable.folderName), SWITCH_NAV)}
						>
							<Grid2x2Icon />
							Grid
						</Button>
						{#if activeTable.read.view.mode === 'typed'}
							{#each activeTable.read.view.contract.views as view (view.id)}
								{@const isActive = activeSurface.kind === 'projection' && activeSurface.projection.id === view.id}
								<Button
									variant={isActive ? 'secondary' : 'ghost'}
									size="xs"
									aria-current={isActive ? 'page' : undefined}
									onclick={() => goto(routes.projection(activeTable.folderName, view.id), SWITCH_NAV)}
								>
									<KanbanIcon />
									{view.title ?? view.id}
								</Button>
							{/each}
						{/if}
					</nav>
				{/if}
				{#if activeTable}
					<IntegritySheet integrity={vault.integrity} />
				{/if}
			</header>

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
								{adopting ? 'Adopting…' : 'Adopt this folder as a table'}
							</Button>
							{#if adoptError}
								<p class="text-sm text-destructive">{adoptError}</p>
							{/if}
						</Empty.Content>
					</Empty.Root>
				{:else}
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
		</Sidebar.Inset>
</Sidebar.Provider>
