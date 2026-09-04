<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnAuthChange } from '@epicenter/auth/svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { authClient } from '$lib/platform/auth';
	import '../app.css';

	let { children } = $props();

	// Nothing is opened here. The layout used to acquire the store during its
	// own initialisation and render pending, ready and failure through an
	// `{#await}`, with a typed context carrying the ready runtime down; opening
	// is an explicit verb now, so the one route calls it and renders the
	// session's four states (ADR-0344). The provider and the context went with
	// the promise: there is one route, and it hands `data` down as a prop.
	//
	// A page lifetime is one auth generation (ADR-0232). Everything below
	// composed itself from the boot-time auth snapshot, so an identity change or
	// a repaired credential reloads rather than swapping anything in place; the
	// next boot rebuilds the right documents and sync from scratch.
	$effect(() => reloadOnAuthChange(authClient));
</script>

<svelte:head><title>Vocab</title></svelte:head>

<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>

<Toaster />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
