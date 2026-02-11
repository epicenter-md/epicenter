<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import SettingsIcon from '@lucide/svelte/icons/settings';

	type Props = {
		displayName: string;
		tables: string[];
		kvKeys: string[];
	};

	let { displayName, tables, kvKeys }: Props = $props();
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg">
					<div
						class="flex size-8 items-center justify-center rounded-md border bg-background"
					>
						<DatabaseIcon class="size-4" />
					</div>
					<div class="flex flex-col gap-0.5 leading-none">
						<span class="font-semibold">{displayName}</span>
						<span class="text-muted-foreground text-xs">Static Workspace</span>
					</div>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton>
						{#snippet child({ props })}
							<a href="/" {...props}>
								<LayoutGridIcon />
								<span>All Workspaces</span>
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Group>

		<Sidebar.Separator />

		<!-- Tables -->
		<Sidebar.Group>
			<Sidebar.GroupLabel>Tables ({tables.length})</Sidebar.GroupLabel>
			<Sidebar.Menu>
				{#each tables as tableName (tableName)}
					<Sidebar.MenuItem>
						<Sidebar.MenuButton>
							<TableIcon />
							<span>{tableName}</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				{:else}
					<Sidebar.MenuItem>
						<span class="text-muted-foreground text-sm">No tables</span>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		</Sidebar.Group>

		<!-- KV -->
		<Sidebar.Group>
			<Sidebar.GroupLabel>Settings ({kvKeys.length})</Sidebar.GroupLabel>
			<Sidebar.Menu>
				{#each kvKeys as key (key)}
					<Sidebar.MenuItem>
						<Sidebar.MenuButton>
							<SettingsIcon />
							<span>{key}</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				{:else}
					<Sidebar.MenuItem>
						<span class="text-muted-foreground text-sm">No settings</span>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		</Sidebar.Group>
	</Sidebar.Content>
</Sidebar.Root>
