<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Table2Icon from '@lucide/svelte/icons/table-2';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import XIcon from '@lucide/svelte/icons/x';
	import { basename } from '@epicenter/matter-core';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { openVaults } from '$lib/open-vaults.svelte';
	import { routes, SWITCH_NAV, type VaultSurface } from '$lib/routes';
	import type { TableHandle } from '$lib/table.svelte';

	let {
		tables,
		activeTable,
		activeSurface,
		collapseOnNavigate,
	}: {
		tables: TableHandle[];
		activeTable?: TableHandle;
		activeSurface: VaultSurface;
		collapseOnNavigate: boolean;
	} = $props();

	const sidebar = Sidebar.useSidebar();

	function finishNavigation(): void {
		if (collapseOnNavigate) sidebar.setOpen(false);
	}

	async function selectSurface(to: string): Promise<void> {
		finishNavigation();
		await goto(to, SWITCH_NAV);
	}

	async function closeVault(id: string): Promise<void> {
		const wasActive = page.params.id === id;
		const index = openVaults.list.findIndex((vault) => vault.id === id);
		openVaults.close(id);
		if (!wasActive) return;

		const remaining = openVaults.list;
		const next = remaining[index] ?? remaining[index - 1];
		await goto(next ? routes.vault(next.id) : routes.home());
	}
</script>

<Sidebar.Root collapsible="offcanvas">
	<Sidebar.Header class="flex-row items-center">
		<div class="flex size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
			<FolderOpenIcon class="size-4" />
		</div>
		<div class="min-w-0 flex-1">
			<div class="truncate text-sm font-semibold">Matter</div>
			<div class="truncate text-xs text-muted-foreground">Markdown workbench</div>
		</div>
		<Sidebar.Trigger tooltip="Toggle navigation" />
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Vaults</Sidebar.GroupLabel>
			<Sidebar.GroupAction title="Open vault" onclick={openVaults.open}>
				<PlusIcon />
				<span class="sr-only">Open vault</span>
			</Sidebar.GroupAction>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each openVaults.list as vault (vault.id)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={page.params.id === vault.id}
								tooltipContent={basename(vault.root)}
							>
							{#snippet child({ props })}
								<a
									href={routes.vault(vault.id)}
									aria-current={page.params.id === vault.id ? 'page' : undefined}
									onclick={finishNavigation}
									{...props}
								>
										<FolderIcon />
										<span>{basename(vault.root)}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
							<Sidebar.MenuAction
								showOnHover
								title="Close {basename(vault.root)}"
								onclick={() => closeVault(vault.id)}
							>
								<XIcon />
								<span class="sr-only">Close {basename(vault.root)}</span>
							</Sidebar.MenuAction>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		{#if tables.length}
			<Sidebar.Separator />

			<Sidebar.Group>
				<Sidebar.GroupLabel>Tables</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each tables as table (table.folderName)}
							{@const isActive = activeSurface.kind !== 'panel' && activeTable?.folderName === table.folderName}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									{isActive}
									aria-current={isActive ? 'page' : undefined}
									onclick={() => selectSurface(routes.table(table.folderName))}
								>
									<Table2Icon />
									<span>{table.folderName}</span>
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>

			<Sidebar.Group>
				<Sidebar.GroupLabel>Tools</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={activeSurface.kind === 'panel' && activeSurface.panel === 'sql'}
								aria-current={activeSurface.kind === 'panel' && activeSurface.panel === 'sql' ? 'page' : undefined}
								onclick={() => selectSurface(routes.panel('sql', activeTable?.folderName))}
							>
								<TerminalIcon />
								<span>SQL console</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={activeSurface.kind === 'panel' && activeSurface.panel === 'db'}
								aria-current={activeSurface.kind === 'panel' && activeSurface.panel === 'db' ? 'page' : undefined}
								onclick={() => selectSurface(routes.panel('db', activeTable?.folderName))}
							>
								<DatabaseIcon />
								<span>Database</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}
	</Sidebar.Content>

	{#if activeTable}
		<Sidebar.Footer>
			<p class="truncate px-2 text-xs text-muted-foreground" title={activeTable.path}>
				{activeTable.path}
			</p>
		</Sidebar.Footer>
	{/if}
	<Sidebar.Rail />
</Sidebar.Root>
