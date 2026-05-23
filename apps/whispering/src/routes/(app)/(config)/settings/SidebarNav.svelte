<script lang="ts">
	import { APP_URLS } from '@epicenter/constants/vite';
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { cubicInOut } from 'svelte/easing';
	import { crossfade } from 'svelte/transition';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';

	// `title` is a () => string so paraglide re-runs on locale change
	const items = $derived([
		{ title: m.settings_sidebar_general(), href: '/settings' },
		{ title: m.settings_sidebar_recording(), href: '/settings/recording' },
		{ title: m.settings_sidebar_transcription(), href: '/settings/transcription' },
		{ title: m.settings_sidebar_api_keys(), href: '/settings/api-keys' },
		{ title: m.settings_sidebar_sound(), href: '/settings/sound' },
		{
			title: m.settings_sidebar_shortcuts(),
			href: '/settings/shortcuts/local',
			activePathPrefix: '/settings/shortcuts',
		},
		{ title: m.settings_sidebar_analytics(), href: '/settings/analytics' },
	] satisfies {
		title: string;
		href: string;
		/**
		 * If provided, the item is considered active if the current pathname starts with this prefix.
		 * Otherwise, it is considered active if the current pathname is exactly equal to the item's href.
		 */
		activePathPrefix?: string;
	}[]);

	const [send, receive] = crossfade({
		duration: 250,
		easing: cubicInOut,
	});
</script>

<nav
	class="flex gap-2 overflow-auto lg:flex-col lg:gap-1"
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
			<span class="relative z-10"> {item.title} </span>
		</Button>
	{/each}

	<Button
		href={APP_URLS.DASHBOARD}
		target="_blank"
		variant="ghost"
		class="relative justify-start text-left font-normal text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
	>
		<span class="relative z-10 flex items-center gap-2">
			{m.settings_sidebar_manage_billing()}
			<ExternalLinkIcon class="size-3 text-muted-foreground" />
		</span>
	</Button>
</nav>
