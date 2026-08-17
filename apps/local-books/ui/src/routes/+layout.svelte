<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();

	// The mirror is a local SQLite read: refetch is cheap and staleness matters (a
	// background sync pass or a recategorize fold changes rows), so keep staleTime
	// short and refetch on focus.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 5_000, retry: 1 },
		},
	});
</script>

<svelte:head><title>Local Books</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		<div class="h-dvh bg-background text-foreground">
			{@render children()}
		</div>
	</Tooltip.Provider>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
