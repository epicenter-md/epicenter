<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import type { SyncConnectionStatus } from '@epicenter/data/sync';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { auth } from '#platform/auth';
	import { HAS_FOLDER } from '#platform/folder';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { navigation } from '$lib/navigation.svelte.js';
	import FolderMenuItem from '../components/FolderMenuItem.svelte';
	import PullToFolder from './PullToFolder.svelte';
	import SendFolderEdits from './SendFolderEdits.svelte';
	import type { FolderVerbs } from '$lib/folder.js';

	let {
		syncStatus,
		pull,
		diff,
		push,
	}: {
		syncStatus: () => SyncConnectionStatus | undefined;
		pull: FolderVerbs['pull'];
		diff: FolderVerbs['diff'];
		push: FolderVerbs['push'];
	} = $props();

	const honeycrisp = getHoneycrisp();
	let sync = $state.raw<SyncConnectionStatus | undefined>(undefined);

	$effect(() => {
		sync = syncStatus();
		const timer = setInterval(() => {
			sync = syncStatus();
		}, 1_000);
		return () => clearInterval(timer);
	});

</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<div class="flex min-w-0 items-center gap-1">
				<span class="text-sm font-semibold">Honeycrisp</span>
			</div>
			<div class="flex items-center gap-1">
				<LightSwitch variant="ghost" />
				<AccountPopover
					{auth}
					syncNoun="notes"
				/>
				<Sidebar.Trigger />
			</div>
		</div>
		<div class="px-2 pb-1">
			<Sidebar.Input
				placeholder="Search notes…"
				value={navigation.query}
				oninput={(e) => navigation.setQuery(e.currentTarget.value)}
			/>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={navigation.folderId === null && !navigation.isDeletedView}
							onclick={() => navigation.selectFolder(null)}
						>
							<FileTextIcon class="size-4" />
							<span>All Notes</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{honeycrisp.tables.notes.all.length}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={navigation.isDeletedView && navigation.folderId === null}
							onclick={() => navigation.selectRecentlyDeleted()}
						>
							<TrashIcon class="size-4" />
							<span>Recently Deleted</span>
							{#if honeycrisp.tables.notes.deleted.length > 0}
								<span class="ml-auto text-xs text-muted-foreground">
									{honeycrisp.tables.notes.deleted.length}
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
					onclick={() =>
						honeycrisp.tables.folders.create()}
				>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each honeycrisp.tables.folders.all as folder (folder.id)}
								<FolderMenuItem {folder} />
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

	<Sidebar.Footer>
		{#if HAS_FOLDER}
			<SendFolderEdits {diff} {push} />
			<PullToFolder {pull} />
		{/if}
		{#if sync}
			<div
				class="text-muted-foreground px-2 pb-1 text-[11px] tabular-nums"
				title="Whether this device is connected and caught up with your other devices."
			>
				{sync.connected ? 'Synced' : 'Offline'} · {sync.cursor} changes received
				{#if !sync.connected && sync.attempts > 0}
					· {sync.attempts} failed {sync.attempts === 1 ? 'retry' : 'retries'}
				{/if}
			</div>
		{/if}
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
