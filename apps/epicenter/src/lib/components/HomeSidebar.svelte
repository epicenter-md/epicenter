<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { rpc } from '$lib/query';
	import { createWorkspaceDialog } from '$lib/components/CreateWorkspaceDialog.svelte';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import PlusIcon from '@lucide/svelte/icons/plus';

	const workspaces = createQuery(() => rpc.workspaces.listWorkspaces.options);
	const createWorkspace = createMutation(
		() => rpc.workspaces.createWorkspace.options,
	);
	const openDirectoryMutation = createMutation(
		() => rpc.workspaces.openWorkspacesDirectory.options,
	);
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg">
					<div
						class="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg"
					>
						<FolderIcon class="size-4" />
					</div>
					<div class="grid flex-1 text-left text-sm leading-tight">
						<span class="truncate font-semibold">Epicenter</span>
						<span class="truncate text-xs text-muted-foreground">
							All Workspaces
						</span>
					</div>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Workspaces</Sidebar.GroupLabel>
			<Sidebar.GroupAction
				title="New Workspace"
				onclick={() =>
					createWorkspaceDialog.open({
						onConfirm: async ({ name, id }) => {
							const result = await createWorkspace.mutateAsync({
								name,
								id,
								template: null,
							});
							await invalidateAll();
							// Navigate using the workspace ID
							goto(`/workspaces/${result.id}`);
						},
					})}
			>
				<PlusIcon />
				<span class="sr-only">New Workspace</span>
			</Sidebar.GroupAction>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#if workspaces.isPending}
						<Sidebar.MenuItem>
							<span class="text-muted-foreground px-2 py-1 text-xs">
								Loading...
							</span>
						</Sidebar.MenuItem>
					{:else if workspaces.data}
						{#each workspaces.data as workspace (workspace.id)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton>
									{#snippet child({ props })}
										<a href="/workspaces/{workspace.id}" {...props}>
											<FolderIcon />
											<span>{workspace.name}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{:else}
							<Sidebar.MenuItem>
								<span class="text-muted-foreground px-2 py-1 text-xs">
									No workspaces yet
								</span>
							</Sidebar.MenuItem>
						{/each}
					{/if}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					onclick={() => openDirectoryMutation.mutate(undefined)}
					disabled={openDirectoryMutation.isPending}
				>
					<FolderOpenIcon />
					<span>Open Data Folder</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
