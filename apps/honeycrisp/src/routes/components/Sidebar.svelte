<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { auth } from '#platform/auth';
	import { instanceSetting } from '#platform/instance';
	import { getHoneycrispApp } from '$lib/context.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';
	import FolderMenuItem from '../components/FolderMenuItem.svelte';

	const honeycrisp = getHoneycrispApp();

	// Both footer readings are sampled, not derived. `pressure()` and
	// `syncStatus()` are plain reads off the store and the sync driver, neither
	// of which is reactive, so no `$derived` over them would ever re-run. These
	// are `$state.raw` because each poll replaces the whole snapshot and nothing
	// mutates one in place.
	//
	// A second is chosen against what a person can perceive rather than how fast
	// either moves: sync settles in milliseconds and pressure changes only on a
	// write, so a faster tick would render the same footer again.
	function readPressure() {
		const { data, error } = honeycrisp.pressure();
		return error === null ? data : undefined;
	}

	// The one number worth watching. A deleted row leaves a tombstone every
	// device pays for in memory on every load, forever, and only a rebuild
	// reclaims one; a healthy vault sits near the item cost of one note, and ten
	// times that means the document is mostly corpse. Shown rather than logged,
	// because whether it ever matters is a question about how much a real person
	// deletes and nobody has that number yet.
	let pressure = $state.raw(readPressure());

	// Undefined when sync is not part of this app generation, which is not an
	// error state: a build with no auth, a signed-out replica, and a desktop
	// window that holds no credential all show nothing here, correctly.
	let sync = $state.raw(honeycrisp.syncStatus());

	$effect(() => {
		const timer = setInterval(() => {
			pressure = readPressure();
			sync = honeycrisp.syncStatus();
		}, 1_000);
		return () => clearInterval(timer);
	});
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<span class="text-sm font-semibold">Honeycrisp</span>
			<div class="flex items-center gap-1">
				<AccountPopover
					{auth}
					syncNoun="notes"
					instanceConnect={{ appName: 'Honeycrisp', setting: instanceSetting }}
				/>
				<Sidebar.Trigger />
			</div>
		</div>
		<div class="px-2 pb-1">
			<Sidebar.Input
				placeholder="Search notes…"
				value={honeycrisp.state.view.searchQuery}
				oninput={(e) => honeycrisp.state.view.setSearchQuery(e.currentTarget.value)}
			/>
		</div>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={honeycrisp.state.view.selectedFolderId === null && !honeycrisp.state.view.isRecentlyDeletedView}
							onclick={() => honeycrisp.state.view.selectFolder(null)}
						>
							<FileTextIcon class="size-4" />
							<span>All Notes</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{honeycrisp.state.notes.all.length}
							</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					<Sidebar.MenuItem>
						<Sidebar.MenuButton
							isActive={honeycrisp.state.view.isRecentlyDeletedView && honeycrisp.state.view.selectedFolderId === null}
							onclick={() => honeycrisp.state.view.selectRecentlyDeleted()}
						>
							<TrashIcon class="size-4" />
							<span>Recently Deleted</span>
							{#if honeycrisp.state.notes.deleted.length > 0}
								<span class="ml-auto text-xs text-muted-foreground">
									{honeycrisp.state.notes.deleted.length}
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
						runHoneycrispMutation(
							() => honeycrisp.state.folders.create(),
							'Could not create folder',
						)}
				>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each honeycrisp.state.folders.all as folder (folder.id)}
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
		{#if sync}
			<div
				class="text-muted-foreground px-2 pb-1 text-[11px] tabular-nums"
				title="Whether this device currently holds a socket to its authority, and how far through the authority's log it has read. `attempts` counts failed dials since the last one that stayed up."
			>
				{sync.connected ? 'synced' : 'offline'} · read {sync.cursor}
				{#if !sync.connected && sync.attempts > 0}
					· {sync.attempts} failed
				{/if}
			</div>
		{/if}
		{#if pressure}
			<div
				class="text-muted-foreground px-2 pb-1 text-[11px] tabular-nums"
				title="Structs the engine holds, over rows a lens can see. A healthy vault sits near the item cost of one note; ten times that means the document is mostly corpse."
			>
				{pressure.items} items · {pressure.liveRows} notes ·
				{pressure.itemsPerLiveRow.toFixed(1)} each
			</div>
		{/if}
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
