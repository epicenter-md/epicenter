<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '#platform/auth';
	import { instanceSetting } from '#platform/instance';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { navigation } from '$lib/navigation.svelte.js';
	import FolderMenuItem from '../components/FolderMenuItem.svelte';

	const honeycrisp = getHoneycrisp();

	// Bound once, not `$derived`: the application object is frozen for this
	// page lifetime, so whether this generation has an account to rebuild is
	// settled before this component exists. A defined `account` is already a
	// replica stamped into the current document, because that is the only way
	// past the boot gate (ADR-0231, ADR-0233); a device-only generation never
	// offers this.
	const account = honeycrisp.account;
	const rebuild = account?.rebuild;

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
		// Pressure of the document this generation is showing, whichever that is.
		return honeycrisp.pressure();
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
	let sync = $state.raw(account?.syncStatus());

	$effect(() => {
		const timer = setInterval(() => {
			pressure = readPressure();
			sync = account?.syncStatus();
		}, 1_000);
		return () => clearInterval(timer);
	});

	/**
	 * Ask, then rebuild (ADR-0231).
	 *
	 * The application owns the lifecycle and refuses to guess at consent, so the
	 * component that can show the sentence is the one that asks. Cancelling needs
	 * no handler: nothing has happened yet.
	 *
	 * `onConfirm` returns the promise, which is how the dialog earns the rest:
	 * it spins, disables its own confirm, and holds the modal open, so a second
	 * press cannot post a second replace. A success never comes back through this
	 * function in practice, because adoption reloads the page; a refusal does, and
	 * it is honest news rather than a broken app, so it is a toast over an
	 * untouched replica.
	 */
	function confirmRebuild(rebuildWorkspace: NonNullable<typeof rebuild>): void {
		confirmationDialog.open({
			title: 'Reclaim space?',
			description:
				'Deleted notes still take up room until this runs. Your notes stay, and every device downloads a fresh copy. Anything not yet synced, on another device or written here while this runs, will be lost.',
			confirm: { text: 'Reclaim space', variant: 'destructive' },
			onConfirm: async () => {
				const { error } = await rebuildWorkspace();
				if (error === null) return;
				toast.error('Could not reclaim space', {
					description: extractErrorMessage(error),
					id: 'rebuild-workspace',
				});
			},
		});
	}
</script>

<Sidebar.Root>
	<Sidebar.Header>
		<div class="flex items-center justify-between px-2 py-1">
			<span class="text-sm font-semibold">Honeycrisp</span>
			<div class="flex items-center gap-1">
				<LightSwitch variant="ghost" />
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
								{honeycrisp.notes.all.length}
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
							{#if honeycrisp.notes.deleted.length > 0}
								<span class="ml-auto text-xs text-muted-foreground">
									{honeycrisp.notes.deleted.length}
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
						honeycrisp.folders.create()}
				>
					<PlusIcon />
					<span class="sr-only">New Folder</span>
				</Sidebar.GroupAction>
				<Collapsible.Content>
					<Sidebar.GroupContent>
						<Sidebar.Menu>
							{#each honeycrisp.folders.all as folder (folder.id)}
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
				title="Whether this device is connected and caught up with your other devices."
			>
				{sync.connected ? 'Synced' : 'Offline'} · {sync.cursor} changes received
				{#if !sync.connected && sync.attempts > 0}
					· {sync.attempts} failed {sync.attempts === 1 ? 'retry' : 'retries'}
				{/if}
			</div>
		{/if}
		{#if pressure}
			<div
				class="text-muted-foreground px-2 pb-1 text-[11px] tabular-nums"
				title="How much space your notes take up compared to what they need. Deleted notes still take space until you reclaim it."
			>
				{pressure.items} items · {pressure.liveRows} notes ·
				{pressure.itemsPerLiveRow.toFixed(1)} each
			</div>
		{/if}
		<!-- Directly under the pressure reading, because that number is the only
		     reason a person rebuilds: it is where they learn the document is mostly
		     corpse, and the verb that reclaims it belongs in the same breath.
		     Absent in a device generation, which has no workspace. -->
		{#if rebuild}
			<Button
				variant="ghost-destructive"
				size="xs"
				class="w-full justify-start"
				onclick={() => confirmRebuild(rebuild)}
			>
				<RefreshCwIcon class="size-3.5" />
				Reclaim space
			</Button>
		{/if}
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
