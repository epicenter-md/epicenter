<script lang="ts">
	import type { Folder } from '@epicenter/honeycrisp';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { getHoneycrispApp } from '$lib/context.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	const honeycrisp = getHoneycrispApp();

	let { folder }: { folder: Folder } = $props();

	// ─── Rename State ────────────────────────────────────────────────────

	let isEditing = $state(false);
	let editingName = $state('');

	function commitRename() {
		if (editingName.trim()) {
			runHoneycrispMutation(
				honeycrisp.state.folders.rename(folder.id, editingName.trim()),
				'Could not rename folder',
			);
		}
		isEditing = false;
		editingName = '';
	}

	// ─── Delete Confirmation ─────────────────────────────────────────────

	let confirmingDelete = $state(false);
</script>

<Sidebar.MenuItem>
	{#if isEditing}
		<div class="flex items-center gap-2 px-2 py-1">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="flex-1 rounded border bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
				bind:value={editingName}
				onkeydown={(e) => {
				if (e.key === 'Enter') commitRename();
				if (e.key === 'Escape') {
					isEditing = false;
					editingName = '';
				}
				}}
				onblur={commitRename}
				autofocus
			>
		</div>
	{:else}
		<Sidebar.MenuButton
			isActive={honeycrisp.state.view.selectedFolderId === folder.id}
			onclick={() => honeycrisp.state.view.selectFolder(folder.id)}
		>
			{#if folder.icon}
				<span class="text-base leading-none">{folder.icon}</span>
			{:else}
				<FolderIcon class="size-4" />
			{/if}
			<span>{folder.name}</span>
			<span class="ml-auto text-xs text-muted-foreground">
				{honeycrisp.state.notes.countsByFolder[folder.id] ?? 0}
			</span>
		</Sidebar.MenuButton>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Sidebar.MenuAction showOnHover {...props}>
						<EllipsisIcon class="size-4" />
						<span class="sr-only">Folder actions</span>
					</Sidebar.MenuAction>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" side="right" class="w-40">
				<DropdownMenu.Item
					onclick={() => {
					isEditing = true;
					editingName = folder.name;
				}}
				>
					<PencilIcon class="mr-2 size-4" />
					Rename
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					class="text-destructive focus:text-destructive"
					onclick={() => (confirmingDelete = true)}
				>
					<TrashIcon class="mr-2 size-4" />
					Delete
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}
</Sidebar.MenuItem>

<AlertDialog.Root bind:open={confirmingDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Folder?</AlertDialog.Title>
			<AlertDialog.Description>
				Notes in this folder will be moved to All Notes.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={() =>
					runHoneycrispMutation(
						honeycrisp.state.folders.delete(folder.id),
						'Could not delete folder',
					)}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
