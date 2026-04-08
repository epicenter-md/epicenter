<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import * as Card from '@epicenter/ui/card';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { auth } from '$lib/auth';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import { queryClient } from '$lib/query/client';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>Billing — Epicenter</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<div class="min-h-screen bg-background text-foreground">
		{#if auth.isAuthenticated}
			<header class="border-b bg-background/95 backdrop-blur">
				<div
					class="mx-auto max-w-5xl px-6 flex items-center justify-between h-14"
				>
					<span class="text-sm font-semibold tracking-tight">Epicenter</span>
					<UserMenu />
				</div>
			</header>
			<div class="mx-auto max-w-5xl px-6 py-12">{@render children()}</div>
		{:else}
			<div class="flex min-h-screen items-center justify-center">
				<Card.Root class="w-full max-w-sm p-6">
					<AuthForm
						{auth}
						syncNoun="billing"
						onSocialSignIn={() =>
							auth.signInWithSocialRedirect({
								provider: 'google',
								callbackURL: window.location.href,
							})}
					/>
				</Card.Root>
			</div>
		{/if}
	</div>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
