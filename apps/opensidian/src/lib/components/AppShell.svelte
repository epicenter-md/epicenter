<script lang="ts">
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FileIcon from '@lucide/svelte/icons/file';
	import TextIcon from '@lucide/svelte/icons/text';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { searchState } from '$lib/state/search-state.svelte';
	import { sidebarSearchState } from '$lib/state/sidebar-search-state.svelte';
	import { terminalState } from '$lib/state/terminal-state.svelte';
	import { getFileIcon } from '$lib/utils/file-icons';
	import { sampleDataLoader } from '$lib/utils/load-sample-data.svelte';
	import AiChat from './chat/AiChat.svelte';
	import ContentPanel from './editor/ContentPanel.svelte';
	import StatusBar from './editor/StatusBar.svelte';
	import SidebarHeader from './SidebarHeader.svelte';
	import SearchPanel from './search/SearchPanel.svelte';
	import TerminalPanel from './terminal/TerminalPanel.svelte';
	import FileTree from './tree/FileTree.svelte';

	let paletteOpen = $state(false);
	let chatOpen = $state(false);

	// ── First-visit onboarding ──────────────────────────────────────
	let onboarded = false;
	$effect(() => {
		if (onboarded) return;
		if (fsState.rootChildIds.length > 0) {
			onboarded = true;
			return;
		}
		// Empty file tree on first render — seed data, open terminal, show welcome.
		onboarded = true;
		sampleDataLoader.load().then(() => {
			const readme = fsState.walkTree((id, row) => {
				if (row.type === 'file' && row.name === 'README.md')
					return { collect: id, descend: false };
				return { descend: true };
			});
			if (readme[0]) fsState.selectFile(readme[0]);
		});
		terminalState.show();
	});
	$effect(() => {
		if (!paletteOpen) searchState.reset();
	});

	const allFileItems = $derived.by((): CommandPaletteItem[] => {
		if (!paletteOpen || searchState.scope !== 'names') return [];
		return fsState.walkTree<CommandPaletteItem>((id, row) => {
			if (row.type === 'file') {
				const fullPath = fsState.getPath(id) ?? '';
				const lastSlash = fullPath.lastIndexOf('/');
				const parentDir = lastSlash > 0 ? fullPath.slice(1, lastSlash) : '';
				return {
					collect: {
						id,
						label: row.name,
						description: parentDir || undefined,
						icon: getFileIcon(row.name),
						group: 'Files',
						onSelect: () => fsState.selectFile(id),
					},
					descend: false,
				};
			}
			return { descend: true };
		});
	});

	const paletteItems = $derived(
		searchState.shouldFilter ? allFileItems : searchState.searchResults,
	);

	let searchPanelRef: ReturnType<typeof SearchPanel> | undefined = $state();
	let terminalRef: ReturnType<typeof TerminalPanel> | undefined = $state();
	let previousFocus: HTMLElement | null = $state(null);

	// Restore focus when terminal closes (covers both keyboard shortcut and X button).
	let wasOpen = false;
	$effect(() => {
		const isOpen = terminalState.open;
		if (wasOpen && !isOpen) {
			previousFocus?.focus();
			previousFocus = null;
		}
		wasOpen = isOpen;
	});

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
			e.preventDefault();
			if (sidebarSearchState.leftPaneView === 'search') {
				sidebarSearchState.closeSearch();
			} else {
				sidebarSearchState.openSearch();
				requestAnimationFrame(() => searchPanelRef?.focusInput());
			}
		}

		if ((e.metaKey || e.ctrlKey) && e.key === '`') {
			e.preventDefault();
			if (!terminalState.open) {
				previousFocus = document.activeElement as HTMLElement | null;
				terminalState.toggle();
				requestAnimationFrame(() => terminalRef?.focus());
			} else {
				terminalState.toggle();
			}
		}

		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'l') {
			e.preventDefault();
			chatOpen = !chatOpen;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-screen flex-col">
	<Resizable.PaneGroup direction="horizontal" class="flex-1">
		<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
			<div class="flex h-full flex-col">
				<SidebarHeader />
				{#if sidebarSearchState.leftPaneView === 'search'}
					<SearchPanel bind:this={searchPanelRef} />
				{:else}
					<ScrollArea class="flex-1">
						<div class="p-2"><FileTree /></div>
					</ScrollArea>
				{/if}
			</div>
		</Resizable.Pane>
		<Resizable.Handle withHandle />
		<Resizable.Pane defaultSize={chatOpen ? 45 : 75}>
			<Resizable.PaneGroup direction="vertical">
				<Resizable.Pane
					defaultSize={terminalState.open ? 55 : 100}
					minSize={30}
				>
					<ContentPanel />
				</Resizable.Pane>
				{#if terminalState.open}
					<Resizable.Handle withHandle />
					<Resizable.Pane defaultSize={45} minSize={15} maxSize={70}>
						<TerminalPanel bind:this={terminalRef} />
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
		{#if chatOpen}
			<Resizable.Handle withHandle />
			<Resizable.Pane defaultSize={30} minSize={20} maxSize={50}>
				<AiChat />
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
	<StatusBar bind:chatOpen />
	<CommandPalette
		items={paletteItems}
		bind:open={paletteOpen}
		bind:value={searchState.searchQuery}
		placeholder={searchState.scope === 'names' ? 'Search file names...' : searchState.scope === 'content' ? 'Search content...' : 'Search files...'}
		emptyMessage={searchState.scope === 'content' ? 'No content matches.' : searchState.scope === 'both' ? 'No results.' : 'No files found.'}
		title="Search Files"
		description="Search for files by name or content"
		shouldFilter={searchState.shouldFilter}
	>
		{#snippet inputEndContent()}
			<div class="flex items-center gap-0.5">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Toggle
								size="sm"
								pressed={searchState.scope === 'names'}
								onPressedChange={(v) => { searchState.scope = v ? 'names' : 'both'; }}
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
								pressed={searchState.scope === 'content'}
								onPressedChange={(v) => { searchState.scope = v ? 'content' : 'both'; }}
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
