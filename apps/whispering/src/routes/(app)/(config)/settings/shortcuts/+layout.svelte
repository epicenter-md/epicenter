<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { cn } from '@epicenter/ui/utils';
	import { cubicInOut } from 'svelte/easing';
	import { crossfade } from 'svelte/transition';
	import { page } from '$app/state';

	let { children } = $props();

	const [send, receive] = crossfade({
		duration: 250,
		easing: cubicInOut,
	});

	const items = [
		{ href: '/settings/shortcuts/local', title: 'Local Shortcuts' },
		{ href: '/settings/shortcuts/global', title: 'Global Shortcuts' },
	] as const;
</script>

<div class="mx-auto max-w-4xl space-y-6 py-6">
	<SectionHeader.Root>
		<SectionHeader.Title level={1} class="text-3xl">
			Keyboard Shortcuts
		</SectionHeader.Title>
		<SectionHeader.Description class="mt-2">
			Configure keyboard shortcuts to quickly access Whispering features.
		</SectionHeader.Description>
	</SectionHeader.Root>

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
				<span class="relative z-10"> {item.title} </span>
			</Button>
		{/each}
	</nav>

	{@render children()}
</div>
