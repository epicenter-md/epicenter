<script lang="ts">
	import { dev } from '$app/environment';
	import { page } from '$app/state';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { queryClient } from '$lib/query/client';
	import '../app.css';

	let { children } = $props();

	const authSurfacePaths = ['/sign-in', '/consent'];
	const showQueryDevtools = $derived(
		dev && !authSurfacePaths.includes(page.url.pathname),
	);
</script>

<QueryClientProvider client={queryClient}>
	<div class="min-h-screen bg-background text-foreground">
		{@render children()}
	</div>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
{#if showQueryDevtools}
	<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
{/if}
