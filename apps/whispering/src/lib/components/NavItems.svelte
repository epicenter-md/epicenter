<script lang="ts">
	import { page } from '$app/state';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import MigrationDialog, {
		migrationDialog,
	} from '$lib/components/MigrationDialog.svelte';
	import { GithubIcon } from '$lib/components/icons';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { cn } from '@epicenter/ui/utils';
	import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';
	import Database from '@lucide/svelte/icons/database';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import ListIcon from '@lucide/svelte/icons/list';
	import Minimize2Icon from '@lucide/svelte/icons/minimize-2';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { toggleMode } from 'mode-watcher';

	let {
		class: className,
		collapsed = false,
	}: {
		class?: string;
		collapsed?: boolean;
	} = $props();

	const shouldShowMigrationButton = $derived(
		window.__TAURI_INTERNALS__ &&
			(import.meta.env.DEV || migrationDialog.hasIndexedDBData),
	);

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
			href: 'https://github.com/EpicenterHQ/epicenter',
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
			{#if shouldShowMigrationButton}
				<MigrationDialog>
					{#snippet trigger({ props })}
						<DropdownMenu.Item class="flex items-center gap-2" {...props}>
							<div class="relative size-4">
								<Database class="size-4" aria-hidden="true" />
								<span
									class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-500 before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-amber-500/50 before:animate-ping"
								></span>
							</div>
							<span>Database Migration Manager</span>
						</DropdownMenu.Item>
					{/snippet}
				</MigrationDialog>
			{/if}
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
		{#if shouldShowMigrationButton}
			<MigrationDialog>
				{#snippet trigger({ props })}
					<WhisperingButton
						tooltipContent="Database Migration Manager"
						variant="ghost"
						size="icon"
						class="relative"
						{...props}
					>
						<Database class="size-4" aria-hidden="true" />
						<span
							class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-500 before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-amber-500/50 before:animate-ping"
						></span>
					</WhisperingButton>
				{/snippet}
			</MigrationDialog>
		{/if}
	</nav>
{/if}
