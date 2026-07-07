<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { queryClient } from '$lib/query/client';
	import '../app.css';

	let { children } = $props();
</script>

<QueryClientProvider client={queryClient}>
	<div class="min-h-screen bg-background text-foreground">
		{@render children()}
	</div>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
