<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FilePlusIcon from '@lucide/svelte/icons/file-plus';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { sidebarSearchState } from '$lib/state/sidebar-search-state.svelte';
</script>

<Tooltip.Provider>
	<div class="flex h-8 shrink-0 items-center justify-between border-b px-2">
		<div class="flex items-center gap-1.5">
			<div class="flex size-5 items-center justify-center rounded bg-black">
				<img src="/logo.svg" alt="Epicenter" class="size-3.5">
			</div>
			<span class="text-xs font-semibold tracking-tight">opensidian</span>
		</div>
		<div class="flex items-center gap-0.5">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={sidebarSearchState.leftPaneView === 'search' ? 'secondary' : 'ghost'}
							size="icon-xs"
							onclick={() => {
							if (sidebarSearchState.leftPaneView === 'search') {
								sidebarSearchState.closeSearch();
							} else {
								sidebarSearchState.openSearch();
							}
							}}
						>
							<SearchIcon class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Search files (⌘⇧F)</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							onclick={() => fsState.startCreate('folder')}
						>
							<FolderPlusIcon class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>New folder</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							onclick={() => fsState.startCreate('file')}
						>
							<FilePlusIcon class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>New file</Tooltip.Content>
			</Tooltip.Root>
		</div>
	</div>
</Tooltip.Provider>
