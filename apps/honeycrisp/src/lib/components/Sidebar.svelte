<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import UnlockIcon from '@lucide/svelte/icons/unlock';
	import type { Folder, FolderId } from '$lib/workspace';
	import { notesState } from '$lib/state/notes.svelte';

	let editingFolderId = $state<FolderId | null>(null);
	let editingName = $state('');
	let deletingFolderId = $state<FolderId | null>(null);

	function startRename(folder: Folder) {
		editingFolderId = folder.id;
		editingName = folder.name;
	}

	function commitRename() {
		if (editingFolderId && editingName.trim()) {
			notesState.renameFolder(editingFolderId, editingName.trim());
		}
		editingFolderId = null;
		editingName = '';
	}

	function cancelRename() {
		editingFolderId = null;
		editingName = '';
	}

	function confirmDelete() {
		if (deletingFolderId) {
			notesState.deleteFolder(deletingFolderId);
		}
		deletingFolderId = null;
	}

	// ─── Peek (hover-to-reveal) ─────────────────────────────────────────────

	const sidebar = Sidebar.useSidebar();
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

	function lockSidebar() {
		clearTimeout(closeTimer);
		peeking = false;
		sidebar.setOpen(true);
	}

	function unlockSidebar() {
		sidebar.setOpen(false);
	}

	// ─── Grab handle (drag-to-peek) ─────────────────────────────────────────

	let dragging = $state(false);
	let dragStartX = $state(0);
	let dragCurrentX = $state(0);
	let wasDragged = $state(false);

	const SIDEBAR_WIDTH_PX = 256; // 16rem
	const LOCK_THRESHOLD = SIDEBAR_WIDTH_PX * 0.5;
	const TAP_THRESHOLD = 5;

	let dragDistance = $derived(Math.max(0, dragCurrentX - dragStartX));
	let dragFraction = $derived(
		dragging && wasDragged ? Math.min(1, dragDistance / SIDEBAR_WIDTH_PX) : 0,
	);

	function handlePointerDown(e: PointerEvent) {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragStartX = e.clientX;
		dragCurrentX = e.clientX;
		dragging = true;
		wasDragged = false;
	}

	function handlePointerMove(e: PointerEvent) {
		if (!dragging) return;
		if (sidebar.isMobile) return;
		dragCurrentX = e.clientX;
		if (Math.abs(dragCurrentX - dragStartX) > TAP_THRESHOLD) {
			wasDragged = true;
		}
	}

	function handlePointerUp() {
		if (!dragging) return;
		const shouldLock = wasDragged && dragDistance >= LOCK_THRESHOLD;
		dragging = false;
		dragCurrentX = dragStartX;

		if (!wasDragged) {
			if (sidebar.isMobile) {
				sidebar.toggle();
			} else {
				lockSidebar();
			}
		} else if (shouldLock) {
			lockSidebar();
		}
	}

	function handlePointerCancel() {
		dragging = false;
		dragCurrentX = dragStartX;
	}

	// Clean up pending timer on destroy
	$effect(() => {
		return () => clearTimeout(closeTimer);
	});

	// Reset peek/drag when sidebar opens via keyboard shortcut or other external means
	$effect(() => {
		if (sidebar.open) {
			peeking = false;
			dragging = false;
		}
	});
</script>

<!-- Grab handle: visible strip on left edge when sidebar is collapsed -->
{#if (sidebar.isMobile ? !sidebar.openMobile : !sidebar.open && !peeking)}
	<button
		class="fixed left-0 top-0 z-50 flex h-full w-3 items-center justify-center
		       touch-none select-none border-none bg-transparent p-0 md:w-2"
		onmouseenter={startPeek}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerCancel}
		aria-label="Open sidebar"
	>
		<div class="h-14 w-2 rounded-full bg-muted-foreground/50 shadow-sm transition-opacity
		            duration-150 active:opacity-100 md:h-8 md:w-1 md:bg-border md:opacity-40 md:shadow-none md:hover:opacity-80" />
	</button>
{/if}

<div
	class="sidebar-peek-scope"
	class:is-peeking={peeking && !sidebar.open && !sidebar.isMobile}
	class:is-dragging={dragging && wasDragged && !sidebar.open}
	style:--drag-offset="{dragFraction * SIDEBAR_WIDTH_PX}px"
>
	<Sidebar.Root
		onmouseenter={cancelClose}
		onmouseleave={scheduleClose}
	>
		<Sidebar.Header>
			<div class="flex items-center justify-between px-2 py-1">
				<span class="text-sm font-semibold">Honeycrisp</span>
				{#if sidebar.open}
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						onclick={unlockSidebar}
						tooltip="Unlock sidebar"
					>
						<UnlockIcon class="size-4" />
					</Button>
				{:else if peeking}
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						onclick={lockSidebar}
						tooltip="Lock sidebar to keep it open"
					>
						<LockIcon class="size-4" />
					</Button>
				{/if}
			</div>
			<div class="px-2 pb-1">
				<Sidebar.Input
					placeholder="Search notes…"
					value={notesState.searchQuery}
					oninput={(e) => notesState.setSearchQuery(e.currentTarget.value)}
				/>
			</div>
		</Sidebar.Header>

		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={notesState.selectedFolderId === null && !notesState.isRecentlyDeletedView}
								onclick={() => notesState.selectFolder(null)}
							>
								<FileTextIcon class="size-4" />
								<span>All Notes</span>
								<span class="ml-auto text-xs text-muted-foreground">
									{notesState.notes.length}
								</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={notesState.isRecentlyDeletedView && notesState.selectedFolderId === null}
								onclick={() => notesState.selectRecentlyDeleted()}
							>
								<TrashIcon class="size-4" />
								<span>Recently Deleted</span>
								{#if notesState.deletedNotes.length > 0}
									<span class="ml-auto text-xs text-muted-foreground">
										{notesState.deletedNotes.length}
									</span>
								{/if}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>

			<Collapsible.Root open>
				<Sidebar.Group>
					<Collapsible.Trigger>
						<Sidebar.GroupLabel>Folders</Sidebar.GroupLabel>
					</Collapsible.Trigger>
					<Sidebar.GroupAction
						title="New Folder"
						onclick={() => notesState.createFolder()}
					>
						<PlusIcon />
						<span class="sr-only">New Folder</span>
					</Sidebar.GroupAction>
					<Collapsible.Content>
						<Sidebar.GroupContent>
							<Sidebar.Menu>
								{#each notesState.folders as folder (folder.id)}
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
												isActive={notesState.selectedFolderId === folder.id}
												onclick={() => notesState.selectFolder(folder.id)}
											>
												{#if folder.icon}
													<span class="text-base leading-none"
														>{folder.icon}</span
													>
												{:else}
													<FolderIcon class="size-4" />
												{/if}
												<span>{folder.name}</span>
												<span class="ml-auto text-xs text-muted-foreground">
													{notesState.noteCounts[folder.id] ?? 0}
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
												<DropdownMenu.Content
													align="start"
													side="right"
													class="w-40"
												>
													<DropdownMenu.Item onclick={() => startRename(folder)}>
														<PencilIcon class="mr-2 size-4" />
														Rename
													</DropdownMenu.Item>
													<DropdownMenu.Separator />
													<DropdownMenu.Item
														class="text-destructive focus:text-destructive"
														onclick={() => (deletingFolderId = folder.id)}
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
					</Collapsible.Content>
				</Sidebar.Group>
			</Collapsible.Root>
		</Sidebar.Content>

		<Sidebar.Rail />
	</Sidebar.Root>
</div>

<AlertDialog.Root
	open={!!deletingFolderId}
	onOpenChange={(open) => { if (!open) deletingFolderId = null; }}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Folder?</AlertDialog.Title>
			<AlertDialog.Description>
				Notes in this folder will be moved to All Notes.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => (deletingFolderId = null)}
				>Cancel</AlertDialog.Cancel
			>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={confirmDelete}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	/* :global() overrides for sidebar internals — can't be expressed with Tailwind */

	.sidebar-peek-scope {
		display: contents;
	}

	.sidebar-peek-scope :global([data-slot='sidebar-gap']) {
		transition: width 300ms ease-out !important;
	}

	.sidebar-peek-scope :global([data-slot='sidebar-container']) {
		transition: inset-inline-start 300ms ease-out, width 300ms ease-out !important;
	}

	.is-peeking :global([data-slot='sidebar-gap']) {
		width: var(--sidebar-width) !important;
	}

	.is-peeking :global([data-slot='sidebar-container']) {
		inset-inline-start: 0 !important;
	}

	/* During drag: disable transitions, follow pointer directly */
	.is-dragging :global([data-slot='sidebar-gap']) {
		width: var(--drag-offset) !important;
		transition: none !important;
	}

	.is-dragging :global([data-slot='sidebar-container']) {
		inset-inline-start: calc(-1 * (var(--sidebar-width) - var(--drag-offset))) !important;
		transition: none !important;
	}
</style>
