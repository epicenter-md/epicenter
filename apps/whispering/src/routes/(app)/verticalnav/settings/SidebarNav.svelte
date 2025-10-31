<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@repo/ui/button';
	import { cn } from '@repo/ui/utils';
	import { cubicInOut } from 'svelte/easing';
	import { crossfade } from 'svelte/transition';
	import { useSidebar } from '@repo/ui/sidebar';

	const sidebar = useSidebar();

	const items = [
		{ title: 'General', href: '/verticalnav/settings' },
		{ title: 'Recording', href: '/verticalnav/settings/recording' },
		{ title: 'Transcription', href: '/verticalnav/settings/transcription' },
		{ title: 'API Keys', href: '/verticalnav/settings/api-keys' },
		{ title: 'Sound', href: '/verticalnav/settings/sound' },
		{
			title: 'Shortcuts',
			href: '/verticalnav/settings/shortcuts/local',
			activePathPrefix: '/verticalnav/settings/shortcuts',
		},
		{ title: 'Privacy & Analytics', href: '/verticalnav/settings/analytics' },
	] satisfies {
		title: string;
		href: string;
		/**
		 * If provided, the item is considered active if the current pathname starts with this prefix.
		 * Otherwise, it is considered active if the current pathname is exactly equal to the item's href.
		 */
		activePathPrefix?: string;
	}[];

	const [send, receive] = crossfade({
		duration: 250,
		easing: cubicInOut,
	});
</script>

<nav
	class={cn(
		'flex gap-2 overflow-auto',
		sidebar.state === 'collapsed'
			? 'lg:flex-col lg:gap-1'
			: 'xl:flex-col xl:gap-1',
	)}
	aria-label="Settings navigation"
>
	{#each items as item (item.href)}
		{@const isActive = item.activePathPrefix
			? page.url.pathname.startsWith(item.activePathPrefix)
			: page.url.pathname === item.href}

		<Button
			href={item.href}
			variant="ghost"
			class={cn(
				'relative justify-start text-left font-normal transition-colors',
				isActive
					? 'text-sidebar-accent-foreground hover:bg-sidebar-accent/50'
					: 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
			)}
			aria-current={isActive ? 'page' : undefined}
			data-sveltekit-noscroll
		>
			{#if isActive}
				<div
					class="bg-sidebar-accent absolute inset-0 rounded-md"
					in:send={{ key: 'active-sidebar-tab' }}
					out:receive={{ key: 'active-sidebar-tab' }}
				></div>
			{/if}
			<span class="relative z-10">
				{item.title}
			</span>
		</Button>
	{/each}
</nav>
