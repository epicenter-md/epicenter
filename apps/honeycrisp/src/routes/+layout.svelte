<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnAuthChange } from '@epicenter/auth/svelte';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { authClient } from '#platform/auth';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// Auth changes start a fresh document generation. The route that initiated
	// the change does not swap its database in place, so every route boots with
	// one principal and one data capability.
	//
	// `authClient`, not `auth`: this reads `state` once to seed itself and then
	// subscribes by hand, so tracking it would make the effect re-run and rebuild
	// the subscription on the transitions it exists to reload on.
	$effect(() => reloadOnAuthChange(authClient, { callbackDestination: '/' }));
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
