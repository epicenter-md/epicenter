<script lang="ts">
	import { page } from '$app/state';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { GithubIcon } from '$lib/components/icons';
	import * as DropdownMenu from '@repo/ui/dropdown-menu';
	import { cn } from '@repo/ui/utils';
	import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';
	import {
		LayersIcon,
		ListIcon,
		Minimize2Icon,
		MoonIcon,
		MoreVerticalIcon,
		SettingsIcon,
		SunIcon,
	} from '@lucide/svelte';
	import { toggleMode } from 'mode-watcher';

	let {
		class: className,
		collapsed = false,
	}: { class?: string; collapsed?: boolean } = $props();

	const navItems = [
		{
			label: 'Recordings',
			icon: ListIcon,
			type: 'anchor',
			href: '/recordings',
		},
		{
			label: 'Transformations',
			icon: LayersIcon,
			type: 'anchor',
			href: '/transformations',
		},
		{
			label: 'Settings',
			icon: SettingsIcon,
			type: 'anchor',
			href: '/settings',
			activePathPrefix: '/settings',
		},
		{
			label: 'View project on GitHub',
			icon: GithubIcon,
			href: 'https://github.com/epicenter-md/epicenter',
			type: 'anchor',
			external: true,
		},
		{
			label: 'Toggle dark mode',
			icon: SunIcon,
			type: 'theme',
			action: toggleMode,
		},
		...(window.__TAURI_INTERNALS__
			? ([
					{
						label: 'Minimize',
						icon: Minimize2Icon,
						type: 'button',
						action: () => getCurrentWindow().setSize(new LogicalSize(72, 84)),
					},
				] as const)
			: []),
	] satisfies NavItem[];

	type BaseNavItem = {
		label: string;
		icon: unknown;
	};

	type AnchorItem = BaseNavItem & {
		type: 'anchor';
		href: string;
		external?: boolean;
		activePathPrefix?: string;
	};

	type ButtonItem = BaseNavItem & {
		type: 'button';
		action: () => void;
	};

	type ThemeItem = BaseNavItem & {
		type: 'theme';
		action: () => void;
	};

	type NavItem = AnchorItem | ButtonItem | ThemeItem;

	const isItemActive = (item: AnchorItem) => {
		if (item.external) return false;
		if (item.activePathPrefix) {
			return page.url.pathname.startsWith(item.activePathPrefix);
		}
		return page.url.pathname === item.href;
	};
</script>

{#if collapsed}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<WhisperingButton
					tooltipContent="Menu"
					variant="ghost"
					size="icon"
					class={className}
					{...props}
				>
					<MoreVerticalIcon class="size-4" aria-hidden="true" />
				</WhisperingButton>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-56">
			{#each navItems as item}
				{@const Icon = item.icon}
				{#if item.type === 'anchor'}
					{@const isActive = isItemActive(item)}
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a
								href={item.href}
								target={item.external ? '_blank' : undefined}
								rel={item.external ? 'noopener noreferrer' : undefined}
								class={cn(
									'flex items-center gap-2',
									isActive && 'bg-accent text-accent-foreground',
								)}
								{...props}
							>
								<Icon class="size-4" aria-hidden="true" />
								<span>{item.label}</span>
							</a>
						{/snippet}
					</DropdownMenu.Item>
				{:else if item.type === 'button'}
					<DropdownMenu.Item
						onclick={item.action}
						class="flex items-center gap-2"
					>
						<Icon class="size-4" aria-hidden="true" />
						<span>{item.label}</span>
					</DropdownMenu.Item>
				{:else if item.type === 'theme'}
					<DropdownMenu.Item
						onclick={item.action}
						class="flex items-center gap-2"
					>
						<div class="relative size-4">
							<SunIcon
								class="absolute h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
							/>
							<MoonIcon
								class="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
							/>
						</div>
						<span>{item.label}</span>
					</DropdownMenu.Item>
				{/if}
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{:else}
	<nav
		class={cn('flex items-center gap-1.5', className)}
		style="view-transition-name: nav"
	>
		{#each navItems as item}
			{@const Icon = item.icon}
			{#if item.type === 'anchor'}
				{@const isActive = isItemActive(item)}
				<WhisperingButton
					tooltipContent={item.label}
					href={item.href}
					target={item.external ? '_blank' : undefined}
					rel={item.external ? 'noopener noreferrer' : undefined}
					variant={isActive ? 'secondary' : 'ghost'}
					size="icon"
					class={isActive ? 'ring-2 ring-ring/20' : ''}
				>
					<Icon class="size-4" aria-hidden="true" />
				</WhisperingButton>
			{:else if item.type === 'button'}
				<WhisperingButton
					tooltipContent={item.label}
					onclick={item.action}
					variant="ghost"
					size="icon"
				>
					<Icon class="size-4" aria-hidden="true" />
				</WhisperingButton>
			{:else if item.type === 'theme'}
				<WhisperingButton
					tooltipContent={item.label}
					onclick={item.action}
					variant="ghost"
					size="icon"
				>
					<SunIcon
						class="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
					/>
					<MoonIcon
						class="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
					/>
				</WhisperingButton>
			{/if}
		{/each}
	</nav>
{/if}

<style>
	@keyframes ping {
		75%,
		100% {
			transform: scale(2);
			opacity: 0;
		}
	}

	.animate-ping {
		animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
</style>
