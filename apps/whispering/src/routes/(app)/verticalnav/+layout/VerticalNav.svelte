<script lang="ts">
	import * as Sidebar from '@repo/ui/sidebar';
	import {
		HomeIcon,
		ListIcon,
		LayersIcon,
		SettingsIcon,
		SunIcon,
		MoonIcon,
		LogsIcon,
		Minimize2Icon,
		MicIcon,
		PanelLeftIcon,
	} from '@lucide/svelte';
	import { GithubIcon } from '$lib/components/icons';
	import { Separator } from '@repo/ui/separator';
	import { page } from '$app/state';
	import { toggleMode } from 'mode-watcher';
	import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
	import { notificationLog } from '$lib/components/NotificationLog.svelte';
	import type { CreateQueryResult } from '@tanstack/svelte-query';
	import { useSidebar } from '@repo/ui/sidebar';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import CompressionSelector from '$lib/components/settings/selectors/CompressionSelector.svelte';
	import TranscriptionSelector from '$lib/components/settings/selectors/TranscriptionSelector.svelte';
	import TransformationSelector from '$lib/components/settings/selectors/TransformationSelector.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import ManualRecordingButton from '$lib/components/recording/ManualRecordingButton.svelte';
	import VadRecordingButton from '$lib/components/recording/VadRecordingButton.svelte';
	import { commandCallbacks } from '$lib/commands';

	let {
		getRecorderStateQuery,
		getVadStateQuery,
	}: {
		getRecorderStateQuery: CreateQueryResult<any>;
		getVadStateQuery: CreateQueryResult<any>;
	} = $props();

	const sidebar = useSidebar();

	// Navigation items
	const navItems = [
		{ label: 'Home', href: '/verticalnav', icon: HomeIcon, exact: true },
		{ label: 'Recordings', href: '/verticalnav/recordings', icon: ListIcon },
		{
			label: 'Transformations',
			href: '/verticalnav/transformations',
			icon: LayersIcon,
		},
		{ label: 'Settings', href: '/verticalnav/settings', icon: SettingsIcon },
	] as const;

	// Footer items - only essential items (minimize on desktop, notification history)
	const footerItems = [
		...(window.__TAURI_INTERNALS__
			? [
					{
						label: 'Minimize',
						icon: Minimize2Icon,
						action: () => getCurrentWindow().setSize(new LogicalSize(72, 84)),
					},
				]
			: []),
		{
			label: 'Notification History',
			icon: LogsIcon,
			action: () => {
				notificationLog.isOpen = true;
			},
		},
	];

	// Check if route is active
	const isActive = (href: string, exact: boolean = false) => {
		if (exact) {
			return page.url.pathname === href;
		}
		// For non-exact matches, check if pathname starts with href
		return page.url.pathname.startsWith(href);
	};
</script>

<Sidebar.Root
	collapsible="icon"
	side="left"
	variant="sidebar"
	class="overflow-x-hidden [&_[data-slot='sidebar-inner']]:group-data-[collapsible=icon]:[filter:grayscale(50%)] [&_[data-slot='sidebar-inner']]:group-data-[collapsible=icon]:opacity-80 [&_[data-slot='sidebar-inner']]:group-data-[collapsible=icon]:hover:[filter:grayscale(0%)] [&_[data-slot='sidebar-inner']]:group-data-[collapsible=icon]:hover:opacity-100 [&_[data-slot='sidebar-inner']]:transition-[filter,opacity] [&_[data-slot='sidebar-inner']]:duration-200"
>
	<Sidebar.Rail />
	<Sidebar.Header
		class="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center"
	>
		<div
			class="flex items-center justify-between gap-2 p-2 hover:bg-sidebar-accent rounded-md transition-[width,height,padding] w-full group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-1! group-data-[collapsible=icon]:w-auto"
		>
			<button
				onclick={sidebar.toggle}
				class="flex items-center gap-2"
				title="Toggle sidebar"
			>
				<PanelLeftIcon class="size-5 shrink-0" />
				<span class="font-bold text-base group-data-[collapsible=icon]:hidden">
					Whispering
				</span>
			</button>
		</div>
	</Sidebar.Header>

	<!-- Divider after logo/branding (only visible when collapsed) -->
	<Separator class="hidden group-data-[collapsible=icon]:block my-2" />

	<Sidebar.Content class="overflow-x-hidden">
		<!-- Main Navigation Group -->
		<Sidebar.Group
			class="p-1 pb-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center"
		>
			<Sidebar.GroupLabel>Navigation</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu
					class="gap-0.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center"
				>
					{#each navItems as item}
						{@const active = isActive(item.href, item.exact ?? false)}
						<Sidebar.MenuItem class="relative">
							{#if active}
								<div
									class="absolute left-0 top-0 bottom-0 w-1 bg-primary z-10"
								></div>
							{/if}
							<Sidebar.MenuButton
								isActive={active}
								class={active
									? '!bg-primary/20 !text-primary !font-semibold hover:!bg-primary/25'
									: ''}
							>
								{#snippet child({ props })}
									<a
										href={item.href}
										{...props}
										title={item.label}
										onclick={() => {
											if (sidebar.isMobile) {
												sidebar.setOpenMobile(false);
											}
										}}
									>
										<svelte:component this={item.icon} />
										<span>{item.label}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<!-- Divider (only visible when collapsed) -->
		<Separator class="hidden group-data-[collapsible=icon]:block my-2" />

		<!-- Quick Settings Group -->
		<Sidebar.Group
			class="p-1 pb-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center"
		>
			<Sidebar.GroupLabel>Quick Settings</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu
					class="gap-0.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center overflow-x-hidden"
				>
					<!-- Device Selector (mode-aware) -->
					<Sidebar.MenuItem>
						{#if settings.value['recording.mode'] === 'manual'}
							<ManualDeviceSelector
								showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
								unstyled
							/>
						{:else if settings.value['recording.mode'] === 'vad'}
							<VadDeviceSelector
								showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
								unstyled
							/>
						{:else}
							<Sidebar.MenuButton disabled>
								{#snippet child({ props })}
									<button
										{...props}
										disabled
										title="Device selector (not available in upload mode)"
									>
										<MicIcon />
										<span
											class="text-muted-foreground group-data-[collapsible=icon]:hidden"
											>Device Selector</span
										>
									</button>
								{/snippet}
							</Sidebar.MenuButton>
						{/if}
					</Sidebar.MenuItem>

					<!-- Compression Selector -->
					<Sidebar.MenuItem>
						<CompressionSelector
							showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
							unstyled
						/>
					</Sidebar.MenuItem>

					<!-- Transcription Provider Selector -->
					<Sidebar.MenuItem>
						<TranscriptionSelector
							showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
							unstyled
						/>
					</Sidebar.MenuItem>

					<!-- Transformation Provider Selector -->
					<Sidebar.MenuItem>
						<TransformationSelector
							showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
							unstyled
						/>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<!-- Divider (only visible when collapsed) -->
		<Separator class="hidden group-data-[collapsible=icon]:block my-2" />

		<!-- Quick Transcription Group -->
		<Sidebar.Group
			class="p-1 pb-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center"
		>
			<Sidebar.GroupLabel>Quick Transcription</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu
					class="gap-0.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center overflow-x-hidden"
				>
					<!-- VAD Recording Button (toggles start/stop) -->
					<Sidebar.MenuItem>
						<VadRecordingButton
							{getVadStateQuery}
							unstyled
							showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
						/>
					</Sidebar.MenuItem>

					<!-- Manual Recording Button (toggles start/stop) -->
					<Sidebar.MenuItem>
						<ManualRecordingButton
							{getRecorderStateQuery}
							unstyled
							showLabel={sidebar.state === 'expanded' || sidebar.isMobile}
						/>
					</Sidebar.MenuItem>

					<!-- Cancel Manual Recording (fixed position - no layout shift) -->
					<Sidebar.MenuItem>
						<button
							type="button"
							onclick={commandCallbacks.cancelManualRecording}
							class="peer/menu-button outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm transition-[width,height,padding,opacity] focus-visible:ring-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! {getRecorderStateQuery.data !==
							'RECORDING'
								? 'opacity-0 pointer-events-none'
								: ''}"
							title="Cancel recording"
							disabled={getRecorderStateQuery.data !== 'RECORDING'}
						>
							<div class="relative shrink-0">
								<span class="text-base flex items-center justify-center size-4"
									>🚫</span
								>
							</div>
							<span class="group-data-[collapsible=icon]:hidden"
								>Cancel recording</span
							>
						</button>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>

		<!-- Divider (only visible when collapsed) -->
		<Separator class="hidden group-data-[collapsible=icon]:block my-2" />

		<!-- Spacer to push Additional Actions to bottom -->
		<div class="flex-grow"></div>

		<!-- Additional Actions (scrollable, not sticky) -->
		<Sidebar.Group
			class="p-1 pb-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center"
		>
			<Sidebar.GroupContent>
				<Sidebar.Menu
					class="gap-0.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center overflow-x-hidden"
				>
					<!-- Toggle dark mode -->
					<Sidebar.MenuItem>
						<Sidebar.MenuButton>
							{#snippet child({ props })}
								<button
									onclick={toggleMode}
									{...props}
									title="Toggle dark mode"
								>
									<SunIcon
										class="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
									/>
									<MoonIcon
										class="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
									/>
									<span>Toggle dark mode</span>
								</button>
							{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>

					<!-- View project on GitHub -->
					<Sidebar.MenuItem>
						<Sidebar.MenuButton>
							{#snippet child({ props })}
								<a
									href="https://github.com/epicenter-md/epicenter"
									target="_blank"
									rel="noopener noreferrer"
									{...props}
									title="View project on GitHub"
								>
									<svelte:component this={GithubIcon} />
									<span>View project on GitHub</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu
			class="gap-0.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center overflow-x-hidden"
		>
			{#each footerItems as item}
				<Sidebar.MenuItem>
					{#if 'href' in item}
						<Sidebar.MenuButton>
							{#snippet child({ props })}
								<a
									href={item.href}
									target={item.external ? '_blank' : undefined}
									rel={item.external ? 'noopener noreferrer' : undefined}
									{...props}
									title={item.label}
								>
									<svelte:component this={item.icon} />
									<span>{item.label}</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
					{:else if 'action' in item}
						<!-- Remove tooltip to fix click issue -->
						<Sidebar.MenuButton>
							{#snippet child({ props })}
								<button onclick={item.action} {...props} title={item.label}>
									{#if item.isTheme}
										<!-- Theme toggle with animated icons -->
										<SunIcon
											class="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
										/>
										<MoonIcon
											class="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
										/>
									{:else}
										<svelte:component this={item.icon} />
									{/if}
									<span>{item.label}</span>
								</button>
							{/snippet}
						</Sidebar.MenuButton>
					{/if}
				</Sidebar.MenuItem>
			{/each}
		</Sidebar.Menu>
	</Sidebar.Footer>
</Sidebar.Root>
