<script lang="ts">
	import { CommandPalette } from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FileIcon from '@lucide/svelte/icons/file';
	import TextIcon from '@lucide/svelte/icons/text';
	import { opensidian } from '$lib/opensidian';
	import ContentPanel from './editor/ContentPanel.svelte';
	import StatusBar from './editor/StatusBar.svelte';
	import SidebarHeader from './SidebarHeader.svelte';
	import SearchPanel from './search/SearchPanel.svelte';
	import TerminalPanel from './terminal/TerminalPanel.svelte';
	import FileTree from './tree/FileTree.svelte';

	let paletteOpen = $state(false);

	$effect(() => {
		if (!paletteOpen) opensidian.state.paletteSearch.reset();
	});

	let searchPanelRef: ReturnType<typeof SearchPanel> | undefined = $state();
	let terminalRef: ReturnType<typeof TerminalPanel> | undefined = $state();
	let previousFocus: HTMLElement | null = $state(null);

	// Restore focus when terminal closes (covers both keyboard shortcut and X button).
	let wasOpen = false;
	$effect(() => {
		const isOpen = opensidian.state.terminal.open;
		if (wasOpen && !isOpen) {
			previousFocus?.focus();
			previousFocus = null;
		}
		wasOpen = isOpen;
	});

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
			e.preventDefault();
			if (opensidian.state.sidebarSearch.leftPaneView === 'search') {
				opensidian.state.sidebarSearch.closeSearch();
			} else {
				opensidian.state.sidebarSearch.openSearch();
				requestAnimationFrame(() => searchPanelRef?.focusInput());
			}
		}

		if ((e.metaKey || e.ctrlKey) && e.code === 'Backquote')
			e.preventDefault();
			if (!opensidian.state.terminal.open) {
				previousFocus = document.activeElement as HTMLElement | null;
				opensidian.state.terminal.toggle();
				requestAnimationFrame(() => terminalRef?.focus());
			} else {
				opensidian.state.terminal.toggle();
			}
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-screen flex-col">
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<div class="flex h-full flex-col">
				<SidebarHeader />
				{#if opensidian.state.sidebarSearch.leftPaneView === 'search'}
					<SearchPanel bind:this={searchPanelRef} />
				{:else}
					<ScrollArea class="flex-1">
						<div class="p-2"><FileTree /></div>
					</ScrollArea>
				{/if}
			</div>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={75}>
			<Resizable.PaneGroup direction="vertical">
				<Resizable.Pane
					defaultSize={opensidian.state.terminal.open ? 55: 100}
					minSize={30}
				>
					<ContentPanel />
				</Resizable.Pane>
				{#if opensidian.state.terminal.open}
					<Resizable.Handle withHandle />
					<Resizable.Pane defaultSize={45} minSize={15} maxSize={70}>
						<TerminalPanel bind:this={terminalRef} />
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
	</Resizable.PaneGroup>
	<StatusBar />
	<CommandPalette
		items={opensidian.state.paletteSearch.searchResults}
		bind:open={paletteOpen}
		bind:value={opensidian.state.paletteSearch.searchQuery}
		placeholder={opensidian.state.paletteSearch.scope === 'names' ? 'Search file names...': opensidian.state.paletteSearch.scope === 'content' ? 'Search content...': 'Search files...'}
		emptyMessage={opensidian.state.paletteSearch.scope === 'content' ? 'No content matches.': opensidian.state.paletteSearch.scope === 'both' ? 'No results.': 'No files found.'}
		title="Search Files"
		description="Search for files by name or content"
		shouldFilter={opensidian.state.paletteSearch.shouldFilter}
	>
		{#snippet inputEndContent()}
			<div class="flex items-center gap-0.5">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Toggle
								size="sm"
								pressed={opensidian.state.paletteSearch.scope === 'names'}
								onPressedChange={(v) => { opensidian.state.paletteSearch.scope = v ? 'names': 'both'; }}
								aria-label="Names only"
								class="size-6 rounded-sm p-0"
								{...props}
							>
								<FileIcon class="size-3.5" />
							</Toggle>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Names only</Tooltip.Content>
				</Tooltip.Root>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Toggle
								size="sm"
								pressed={opensidian.state.paletteSearch.scope === 'content'}
								onPressedChange={(v) => { opensidian.state.paletteSearch.scope = v ? 'content': 'both'; }}
								aria-label="Content only"
								class="size-6 rounded-sm p-0"
								{...props}
							>
								<TextIcon class="size-3.5" />
							</Toggle>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Content only</Tooltip.Content>
				</Tooltip.Root>
			</div>
		{/snippet}
	</CommandPalette>
</div>
