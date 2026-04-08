<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CommandPalette } from '@epicenter/ui/command-palette';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Toaster } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import CaseSensitiveIcon from '@lucide/svelte/icons/case-sensitive';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import RegexIcon from '@lucide/svelte/icons/regex';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WholeWordIcon from '@lucide/svelte/icons/whole-word';
	import XIcon from '@lucide/svelte/icons/x';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { ModeWatcher } from 'mode-watcher';
	import AiDrawer from '$lib/components/AiDrawer.svelte';
	import { items } from '$lib/components/command-palette-items';
	import SyncStatusIndicator from '$lib/components/SyncStatusIndicator.svelte';
	import UnifiedTabList from '$lib/components/tabs/UnifiedTabList.svelte';
	import { browserState } from '$lib/state/browser-state.svelte';
	import { unifiedViewState } from '$lib/state/unified-view-state.svelte';

	let searchInputRef = $state<HTMLInputElement | null>(null);
	let commandPaletteOpen = $state(false);
	let aiDrawerOpen = $state(false);
	let searchFocused = $state(false);
	const isSearchActive = $derived(
		searchFocused || unifiedViewState.searchQuery !== '',
	);
</script>

{#snippet searchToggle(pressed: boolean, onPressedChange: (v: boolean) => void, Icon: typeof CaseSensitiveIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Toggle
					size="sm"
					{pressed}
					{onPressedChange}
					aria-label={label}
					class="size-6 rounded-sm p-0"
					{...props}
				>
					<Icon class="size-3.5" />
				</Toggle>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<Tooltip.Provider>
	<main
		class="h-full w-full overflow-hidden flex flex-col bg-background text-foreground"
	>
		<header
			class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 px-3 py-2"
		>
			<div class="flex items-center gap-2">
				<div
					class="relative flex-1"
					onfocusin={() => { searchFocused = true; }}
					onfocusout={(e: FocusEvent) => {
						const container = e.currentTarget as HTMLElement;
						if (container.contains(e.relatedTarget as Node)) return;
						searchFocused = false;
					}}
				>
					<SearchIcon
						class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						bind:ref={searchInputRef}
						type="search"
						placeholder="Search tabs..."
						bind:value={unifiedViewState.searchQuery}
						onkeydown={(e: KeyboardEvent) => {
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
						class={isSearchActive
							? "h-8 pl-8 pr-[7.5rem] text-sm [&::-webkit-search-cancel-button]:hidden"
							: "h-8 pl-8 pr-8 text-sm [&::-webkit-search-cancel-button]:hidden"}
					/>
					{#if isSearchActive}
						<div
							class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
						>
							{#if unifiedViewState.searchQuery}
								<button
									type="button"
									class="text-muted-foreground hover:text-foreground"
									onclick={() => {
										unifiedViewState.searchQuery = '';
										searchInputRef?.focus();
									}}
								>
									<XIcon class="size-3.5" />
								</button>
							{/if}
							{@render searchToggle(unifiedViewState.isCaseSensitive, (v) => { unifiedViewState.isCaseSensitive = v; }, CaseSensitiveIcon, 'Match Case')}
							{@render searchToggle(unifiedViewState.isRegex, (v) => { unifiedViewState.isRegex = v; }, RegexIcon, 'Use Regular Expression')}
							{@render searchToggle(unifiedViewState.isExactMatch, (v) => { unifiedViewState.isExactMatch = v; }, WholeWordIcon, 'Match Whole Word')}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<button
											type="button"
											class="flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent"
											{...props}
										>
											{({ all: 'All', title: 'Title', url: 'URL' })[unifiedViewState.searchField]}
											<ChevronDownIcon class="size-2.5" />
										</button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-28">
									<DropdownMenu.RadioGroup
										bind:value={unifiedViewState.searchField}
									>
										<DropdownMenu.RadioItem value="all"
											>All Fields</DropdownMenu.RadioItem
										>
										<DropdownMenu.RadioItem value="title"
											>Title Only</DropdownMenu.RadioItem
										>
										<DropdownMenu.RadioItem value="url"
											>URL Only</DropdownMenu.RadioItem
										>
									</DropdownMenu.RadioGroup>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
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
			<div class="flex flex-1 flex-col items-center justify-center gap-3">
				<Spinner class="size-5 text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Loading tabs…</p>
			</div>
		{:then _}
			<div class="flex-1 min-h-0"><UnifiedTabList /></div>
		{:catch _error}
			<Empty.Root class="flex-1 flex items-center justify-center">
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
<CommandPalette {items} bind:open={commandPaletteOpen} shortcut={null} />
<ModeWatcher />
<Toaster position="bottom-center" richColors closeButton />
<AiDrawer bind:open={aiDrawerOpen} />
