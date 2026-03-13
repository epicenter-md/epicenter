<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { useSidebar } from '@epicenter/ui/sidebar';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import type { Folder, FolderId } from '$lib/workspace';

	let {
		folders,
		selectedFolderId,
		noteCounts,
		totalNoteCount,
		searchQuery,
		onSelectFolder,
		onCreateFolder,
		onRenameFolder,
		onDeleteFolder,
		onSearchChange,
	}: {
		folders: Folder[];
		selectedFolderId: FolderId | null;
		noteCounts: Record<string, number>;
		totalNoteCount: number;
		searchQuery: string;
		onSelectFolder: (folderId: FolderId | null) => void;
		onCreateFolder: () => void;
		onRenameFolder: (folderId: FolderId, name: string) => void;
		onDeleteFolder: (folderId: FolderId) => void;
		onSearchChange: (query: string) => void;
	} = $props();

	let editingFolderId = $state<FolderId | null>(null);
	let editingName = $state('');

	function startRename(folder: Folder) {
		editingFolderId = folder.id;
		editingName = folder.name;
	}

	function commitRename() {
		if (editingFolderId && editingName.trim()) {
			onRenameFolder(editingFolderId, editingName.trim());
		}
		editingFolderId = null;
		editingName = '';
	}

	function cancelRename() {
		editingFolderId = null;
		editingName = '';
	}

	// ─── Peek (Notion-style hover-to-reveal) ────────────────────────────────

	const sidebar = useSidebar();
	let peeking = $state(false);
	let closeTimer: ReturnType<typeof setTimeout>;

	function startPeek() {
		clearTimeout(closeTimer);
		peeking = true;
	}

	function scheduleClose() {
		if (!peeking) return;
		closeTimer = setTimeout(() => {
			peeking = false;
		}, 400);
	}

	function cancelClose() {
		clearTimeout(closeTimer);
	}

	$effect(() => {
		if (sidebar.open) peeking = false;
	});
</script>

<!-- Peek hover zone: thin strip on left edge when sidebar is collapsed -->
{#if !sidebar.open && !sidebar.isMobile && !peeking}
	<button
		class="peek-zone"
		onmouseenter={startPeek}
		title="Hover to peek"
		aria-label="Open sidebar"
	>
		<div class="peek-zone-indicator" />
	</button>
{/if}

<div
	class="sidebar-peek-wrapper"
	class:is-peeking={peeking && !sidebar.open && !sidebar.isMobile}
>
	<Sidebar.Root
		onmouseenter={cancelClose}
		onmouseleave={scheduleClose}
	>
		<Sidebar.Header>
			<div class="flex items-center justify-between px-2 py-1">
				<span class="text-sm font-semibold">Honeycrisp</span>
				<Sidebar.Trigger />
			</div>
			<div class="px-2 pb-1">
				<Sidebar.Input
					placeholder="Search notes…"
					value={searchQuery}
					oninput={(e) => onSearchChange(e.currentTarget.value)}
				/>
			</div>
		</Sidebar.Header>

		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={selectedFolderId === null}
								onclick={() => onSelectFolder(null)}
							>
								<FileTextIcon class="size-4" />
								<span>All Notes</span>
								<span class="ml-auto text-xs text-muted-foreground">
									{totalNoteCount}
								</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>

			<Sidebar.Group>
				<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
				<Sidebar.GroupAction title="New Folder" onclick={onCreateFolder}>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each folders as folder (folder.id)}
							<Sidebar.MenuItem>
								{#if editingFolderId === folder.id}
									<div class="flex items-center gap-2 px-2 py-1">
										<!-- svelte-ignore a11y_autofocus -->
										<input
											class="flex-1 rounded border bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
											bind:value={editingName}
											onkeydown={(e) => {
												if (e.key === 'Enter') commitRename();
												if (e.key === 'Escape') cancelRename();
											}}
											onblur={commitRename}
											autofocus
										>
									</div>
								{:else}
									<Sidebar.MenuButton
										isActive={selectedFolderId === folder.id}
										onclick={() => onSelectFolder(folder.id)}
									>
										{#if folder.icon}
											<span class="text-base leading-none">{folder.icon}</span>
										{:else}
											<FolderIcon class="size-4" />
										{/if}
										<span>{folder.name}</span>
										<span class="ml-auto text-xs text-muted-foreground">
											{noteCounts[folder.id] ?? 0}
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
											<DropdownMenu.Item onclick={() => startRename(folder)}>
												<PencilIcon class="mr-2 size-4" />
												Rename
											</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item
												class="text-destructive focus:text-destructive"
												onclick={() => onDeleteFolder(folder.id)}
											>
												<TrashIcon class="mr-2 size-4" />
												Delete
											</DropdownMenu.Item>
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								{/if}
							</Sidebar.MenuItem>
						{:else}
							<Sidebar.MenuItem>
								<span class="text-muted-foreground px-2 py-1 text-xs">
									No folders yet
								</span>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>

		<Sidebar.Footer>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Button
						variant="ghost"
						size="sm"
						class="w-full justify-start gap-2"
						onclick={onCreateFolder}
					>
						<PlusIcon class="size-4" />
						<span>New Folder</span>
					</Button>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Footer>

		<Sidebar.Rail />
	</Sidebar.Root>
</div>

<style>
	/* Peek zone: thin fixed strip on left edge */
	.peek-zone {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		width: 0.375rem;
		height: 100%;
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.peek-zone-indicator {
		margin: 0 auto;
		height: 2rem;
		width: 0.1875rem;
		border-radius: 9999px;
		background: var(--color-border);
		opacity: 0;
		transition: opacity 150ms;
	}

	.peek-zone:hover .peek-zone-indicator {
		opacity: 0.6;
	}

	/* Smooth 300ms ease-out for both open and close */
	.sidebar-peek-wrapper :global([data-slot='sidebar-gap']) {
		transition-duration: 300ms !important;
		transition-timing-function: ease-out !important;
	}

	.sidebar-peek-wrapper :global([data-slot='sidebar-container']) {
		transition-duration: 300ms !important;
		transition-timing-function: ease-out !important;
	}

	/* When peeking, slide sidebar on-screen and push content over */
	.is-peeking :global([data-slot='sidebar-gap']) {
		width: var(--sidebar-width) !important;
	}

	.is-peeking :global([data-slot='sidebar-container']) {
		inset-inline-start: 0 !important;
	}
</style>
