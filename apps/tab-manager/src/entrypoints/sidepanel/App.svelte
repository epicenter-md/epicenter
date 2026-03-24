<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { onMount } from 'svelte';
	import AiDrawer from '$lib/components/AiDrawer.svelte';
	import { CommandPalette } from '$lib/components/command-palette';
	import SyncStatusIndicator from '$lib/components/SyncStatusIndicator.svelte';
	import UnifiedTabList from '$lib/components/tabs/UnifiedTabList.svelte';
	import { authState } from '$lib/state/auth.svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import { unifiedViewState } from '$lib/state/unified-view-state.svelte';
	import { registerDevice } from '$lib/workspace';

	// Auth initialization — check cached session on mount
	onMount(() => {
		authState.checkSession();
		void registerDevice();
		// External sign-in handled by $effect in auth.svelte.ts
		// Sync naturally handles auth token changes (stable client, no rebuild needed)
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.status === 'signed-in'
			) {
				authState.checkSession();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	let searchInputRef = $state<HTMLInputElement | null>(null);
	let commandPaletteOpen = $state(false);
	let aiDrawerOpen = $state(false);
</script>

<Tooltip.Provider>
	<main
		class="h-full w-full overflow-hidden flex flex-col bg-background text-foreground"
	>
		<header
			class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 px-3 py-2"
		>
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<SearchIcon
						class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						bind:ref={searchInputRef}
						type="search"
						placeholder="Search tabs..."
						bind:value={unifiedViewState.searchQuery}
						onkeydown={(e) => {
					// "/" in empty input opens command palette
					if (e.key === '/' && unifiedViewState.searchQuery === '') {
						e.preventDefault();
						commandPaletteOpen = true;
					}
					// "@" in empty input opens AI drawer (Phase 4)
					if (e.key === '@' && unifiedViewState.searchQuery === '') {
						e.preventDefault();
						aiDrawerOpen = true;
					}
					// Escape clears search
					if (e.key === 'Escape') {
						unifiedViewState.searchQuery = '';
						searchInputRef?.blur();
					}
				}}
						class="h-8 pl-8 pr-8 text-sm [&::-webkit-search-cancel-button]:hidden"
					/>
					{#if unifiedViewState.searchQuery}
						<button
							type="button"
							class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							onclick={() => {
								unifiedViewState.searchQuery = '';
								searchInputRef?.focus();
							}}
						>
							<XIcon class="size-3.5" />
						</button>
					{/if}
				</div>
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="Commands"
					onclick={() => {
						commandPaletteOpen = true;
					}}
				>
					<TerminalIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="AI Chat"
					onclick={() => {
						aiDrawerOpen = true;
					}}
				>
					<ZapIcon />
				</Button>
				<SyncStatusIndicator />
			</div>
		</header>
		<!-- Gate on browser state seed so child components can read data synchronously -->
		{#await browserState.whenReady}
			<div class="flex-1 flex items-center justify-center">
				<div class="flex flex-col items-center gap-3">
					<Spinner class="size-5 text-muted-foreground" />
					<p class="text-sm text-muted-foreground">Loading tabs…</p>
				</div>
			</div>
		{:then _}
			<div class="flex-1 min-h-0"><UnifiedTabList /></div>
		{:catch _}
			<Empty.Root class="flex-1">
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load tabs</Empty.Title>
				<Empty.Description>
					Something went wrong loading browser state. Try reopening the side
					panel.
				</Empty.Description>
			</Empty.Root>
		{/await}
	</main>
</Tooltip.Provider>
<ConfirmationDialog />
<CommandPalette bind:open={commandPaletteOpen} />
<AiDrawer bind:open={aiDrawerOpen} />
