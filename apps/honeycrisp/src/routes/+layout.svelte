<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { workspace } from '$lib/client';
	import { queryClient } from '$lib/query/client';
	import '@epicenter/ui/app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';

	let { children } = $props();
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<WorkspaceGate whenReady={workspace.whenReady}>
		<Tooltip.Provider>{@render children()}</Tooltip.Provider>
	</WorkspaceGate>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
