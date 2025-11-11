<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@repo/ui/button';
	import { cn } from '@repo/ui/utils';
	import { cubicInOut } from 'svelte/easing';
	import { crossfade } from 'svelte/transition';

	let { children } = $props();

	const [send, receive] = crossfade({
		duration: 250,
		easing: cubicInOut,
	});

	const items = [
		{ href: '/verticalnav/settings/shortcuts/local', title: 'Local Shortcuts' },
		{
			href: '/verticalnav/settings/shortcuts/global',
			title: 'Global Shortcuts',
		},
	] as const;
</script>

<div class="mx-auto max-w-4xl space-y-6 py-6">
	<header>
		<h1 class="text-3xl font-bold tracking-tight">Keyboard Shortcuts</h1>
		<p class="mt-2 text-muted-foreground">
			Configure keyboard shortcuts to quickly access Whispering features.
		</p>
	</header>

	<nav class="flex w-full gap-1 rounded-lg bg-muted p-1">
		{#each items as item (item.href)}
			{@const isActive = page.url.pathname === item.href}
			<Button
				href={item.href}
				variant="ghost"
				class={cn(
					'relative flex-1 justify-center transition-colors',
					isActive
						? 'text-foreground hover:text-foreground'
						: 'text-muted-foreground hover:text-foreground',
				)}
				data-sveltekit-noscroll
			>
				{#if isActive}
					<div
						class="absolute inset-0 rounded-md bg-background shadow-sm"
						in:send={{ key: 'active-tab' }}
						out:receive={{ key: 'active-tab' }}
					></div>
				{/if}
				<span class="relative z-10">
					{item.title}
				</span>
			</Button>
		{/each}
	</nav>

	{@render children()}
</div>
