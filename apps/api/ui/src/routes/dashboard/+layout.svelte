<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import { auth } from '$lib/platform/auth';

	let { children } = $props();

	const startSignIn = createMutation(() =>
		mutationOptions({
			mutationKey: ['auth', 'startSignIn'],
			mutationFn: () => auth.startSignIn(),
		}),
	);
</script>

<svelte:head><title>Billing: Epicenter</title></svelte:head>

{#if auth.state.status === 'signed-in'}
	<header class="border-b bg-background/95 backdrop-blur">
		<div class="mx-auto max-w-5xl px-6 flex items-center justify-between h-14">
			<span class="text-sm font-semibold tracking-tight">Epicenter</span>
			<UserMenu />
		</div>
	</header>
	<div class="mx-auto max-w-5xl px-6 py-12">{@render children()}</div>
{:else}
	<div class="flex min-h-screen items-center justify-center">
		<Card.Root class="w-full max-w-sm p-6">
			<div class="space-y-4 text-center">
				<div class="space-y-1">
					<p class="text-sm font-medium">Sign in to Epicenter</p>
					<p class="text-xs text-muted-foreground">
						Sign in to view billing and usage.
					</p>
				</div>
				{#if startSignIn.error}
					<p class="text-xs text-destructive">{startSignIn.error.message}</p>
				{/if}
				<Button
					class="w-full"
					onclick={() => startSignIn.mutate()}
					disabled={startSignIn.isPending}
				>
					{#if startSignIn.isPending}
						<LoaderCircle class="size-4 animate-spin" />
						Signing in…
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</div>
		</Card.Root>
	</div>
{/if}
