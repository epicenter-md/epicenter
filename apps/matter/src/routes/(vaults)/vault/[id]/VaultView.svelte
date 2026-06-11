<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { createVault } from '$lib/vault.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	let { path }: { path: string } = $props();

	// This keyed component IS the live vault for the active route: construct on mount,
	// dispose on destroy. The route's `{#key data.path}` tears this instance down and
	// builds a fresh one when the active folder changes, so the OS watcher's lifetime
	// rides the component's, with no session singleton driving it.
	// svelte-ignore state_referenced_locally - the route keys this component on path, so it remounts (not re-renders) when the active folder changes; capturing the initial path here is the intent.
	const vault = createVault(path);
	$effect(() => () => vault.dispose());

	// One WHERE filter per tab: each open vault gets its own clause. It takes the vault at
	// construction and owns its own effect (re-querying on a clause or mirror change, cancelling
	// stale runs), so there is nothing to wire here. FolderGrid renders its input and rows.
	const filter = createWhereFilter(vault);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await vault.whenReady}
		<Empty.Root class="flex-1 border-0" aria-live="polite">
			<Empty.Media><Spinner class="size-5 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Loading {vault.folderName}</Empty.Title>
		</Empty.Root>
	{:then _}
		{#if vault.writeError}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
				<Alert.Description class="text-xs">
					Couldn't save: {vault.writeError}
				</Alert.Description>
			</Alert.Root>
		{/if}
		<FolderGrid {vault} {filter} />
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't watch {vault.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
