<script lang="ts">
	import {
		StorageMovedScreen,
		storageMoved,
	} from '@epicenter/app-shell/storage-moved';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnPrincipalChange } from '@epicenter/svelte/auth';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { auth } from '#platform/auth';
	import { honeycrisp } from '$lib/honeycrisp';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// Runtime authority is selected once at boot. A principal identity change
	// reloads so the next boot opens the matching device or account database.
	onMount(() => reloadOnPrincipalChange(auth));
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

{#if storageMoved.current}
	<StorageMovedScreen />
{:else}
	<WorkspaceGate
		pending={honeycrisp.whenReady}
		onSignOut={() => auth.signOut()}
	>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</WorkspaceGate>
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
