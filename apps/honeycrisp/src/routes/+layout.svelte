<script lang="ts">
	import {
		StorageMovedScreen,
		storageMoved,
	} from '@epicenter/app-shell/storage-moved';
	import { WorkspaceBootFailure } from '@epicenter/app-shell/workspace-gate';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnPrincipalChange } from '@epicenter/svelte/auth';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { auth } from '#platform/auth';
	import HoneycrispAppProvider from '$lib/HoneycrispAppProvider.svelte';
	import { openHoneycrispApplication } from '$lib/application.js';
	import { honeycrispPlatform } from '$lib/application-platform.js';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// Runtime authority is selected once at boot. A principal identity change
	// reloads so the next boot opens the matching device or account database.
	onMount(() => reloadOnPrincipalChange(auth));

	const boot = new AbortController();
	const opening = openHoneycrispApplication(honeycrispPlatform, {
		signal: boot.signal,
	});
	$effect(() => {
		if (storageMoved.current) boot.abort();
		return () => boot.abort();
	});
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

{#if storageMoved.current}
	<StorageMovedScreen />
{:else}
	{#await opening}
		<Loading class="h-dvh" />
	{:then application}
		<HoneycrispAppProvider {application}>
			<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
		</HoneycrispAppProvider>
	{:catch error}
		<WorkspaceBootFailure {error} onSignOut={() => auth.signOut()} />
	{/await}
{/if}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
