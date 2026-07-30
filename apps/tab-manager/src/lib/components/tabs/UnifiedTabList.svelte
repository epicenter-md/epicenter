<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { cn } from '@epicenter/ui/utils';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { VList } from 'virtua/svelte';
	import { getTabManagerApp } from '$lib/context';
	import { browserState } from '$lib/state/browser-state.svelte';
	import { getDomain, getRelativeTime } from '$lib/utils/format';
	import TabFavicon from './TabFavicon.svelte';
	import TabItem from './TabItem.svelte';

	const tabManager = getTabManagerApp();
</script>

{#if tabManager.state.unifiedView.flatItems.length === 0}
	<Empty.Root class="py-8">
		<Empty.Media>
			{#if tabManager.state.unifiedView.isFiltering}
				<SearchIcon class="size-8 text-muted-foreground" />
			{:else}
				<FolderOpenIcon class="size-8 text-muted-foreground" />
			{/if}
		</Empty.Media>
		{#if tabManager.state.unifiedView.isFiltering}
			<Empty.Title>No matching tabs</Empty.Title>
			<Empty.Description>
				{#if tabManager.state.unifiedView.isRegex && tabManager.state.unifiedView.isRegexInvalid}
					Check your regular expression syntax
				{:else}
					No tabs match "{tabManager.state.unifiedView.searchQuery}"
				{/if}
			</Empty.Description>
		{:else}
			<Empty.Title>No tabs found</Empty.Title>
			<Empty.Description>Open some tabs to see them here</Empty.Description>
		{/if}
	</Empty.Root>
{:else}
	<VList
		data={tabManager.state.unifiedView.flatItems}
		style="height: 100%;"
		getKey={(item) => {
			switch (item.kind) {
				case 'section-header':
					return `section-${item.section}`;
				case 'window-header':
					return `window-${item.window.id}`;
				case 'tab':
					return `tab-${item.tab.id}`;
				case 'saved-tab':
					return `saved-${item.savedTab.id}`;
				case 'bookmark':
					return `bookmark-${item.bookmark.id}`;
			}
		}}
	>
		{#snippet children(item)}
			{#if item.kind === 'section-header'}
				{@const isExpanded =
					tabManager.state.unifiedView.isFiltering ||
					tabManager.state.unifiedView.isSectionExpanded(item.section)}
				<div
					class="sticky top-0 z-20 flex w-full items-center gap-2 border-b bg-background px-4 py-2.5 text-sm font-medium"
				>
					<button
						type="button"
						disabled={item.count === 0}
						onclick={() => {
							if (!tabManager.state.unifiedView.isFiltering) {
								tabManager.state.unifiedView.toggleSection(item.section);
							}
						}}
						class="group flex flex-1 items-center gap-2 transition enabled:cursor-pointer enabled:hover:opacity-80"
					>
						<ChevronRightIcon
							class={cn(
								'size-4 shrink-0 text-muted-foreground transition group-disabled:invisible',
								isExpanded && 'rotate-90',
							)}
						/>
						<span>{item.label}</span>
						<Badge variant="outline" class="ml-auto shrink-0">
							{item.count}
						</Badge>
					</button>
					{#if item.section === 'saved' && tabManager.state.savedTabs.tabs.length > 0 && isExpanded}
						<div class="flex gap-1">
							<Button
								variant="ghost"
								size="icon-xs"
								tooltip="Restore All"
								onclick={() => void tabManager.state.savedTabs.restoreAll()}
							>
								<RotateCcwIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								class="text-destructive"
								tooltip="Delete All"
								onclick={() => tabManager.state.savedTabs.removeAll()}
							>
								<Trash2Icon />
							</Button>
						</div>
					{/if}
				</div>
			{:else if item.kind === 'window-header'}
				{@const windowTabs = browserState.tabsByWindow(item.window.id)}
				{@const activeTab = windowTabs.find((t) => t.active)}
				{@const firstTab = windowTabs.at(0)}
				{@const isExpanded =
					tabManager.state.unifiedView.isFiltering ||
					tabManager.state.unifiedView.isWindowExpanded(item.window.id)}
				<button
					type="button"
					onclick={() => {
						if (!tabManager.state.unifiedView.isFiltering) {
						tabManager.state.unifiedView.toggleWindow(item.window.id);
						}
					}}
					class="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm text-muted-foreground backdrop-blur transition hover:bg-muted/80"
				>
					<ChevronRightIcon
						class={cn(
							'size-4 shrink-0 transition',
							isExpanded && 'rotate-90',
						)}
					/>
					<AppWindowIcon class="size-4 shrink-0" />
					<span class="truncate">
						{(activeTab ?? firstTab)?.title ?? 'Window'}
					</span>
					{#if item.window.focused}
						<Badge variant="secondary" class="ml-auto shrink-0">focused</Badge>
					{/if}
					<Badge variant="outline" class="shrink-0">
						{windowTabs.length}
					</Badge>
				</button>
			{:else if item.kind === 'tab'}
				<div class="border-b border-border"><TabItem tab={item.tab} /></div>
			{:else if item.kind === 'saved-tab'}
				{@const tab = item.savedTab}
				<div class="border-b border-border">
					<Item.Root size="sm" class="hover:bg-accent/50">
						<Item.Media> <TabFavicon src={tab.favIconUrl} /> </Item.Media>

						<Item.Content>
							<Item.Title>
								<span class="truncate">{tab.title || 'Untitled'}</span>
							</Item.Title>
							<Item.Description
								class="flex min-w-0 items-center gap-2 truncate"
							>
								<span class="truncate">{getDomain(tab.url)}</span>
								<span>•</span>
								<span class="shrink-0">{getRelativeTime(tab.savedAt)}</span>
							</Item.Description>
						</Item.Content>

						<Item.Actions showOnHover class="gap-1">
							<Button
								variant="ghost"
								size="icon-xs"
								tooltip="Restore"
								onclick={() =>
							tabManager.state.savedTabs.restore(tab).then((r) => toastOnError(r, 'Failed to restore tab'))}
							>
								<RotateCcwIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								class="text-destructive"
								tooltip="Delete"
								onclick={() => tabManager.state.savedTabs.remove(tab.id)}
							>
								<Trash2Icon />
							</Button>
						</Item.Actions>
					</Item.Root>
				</div>
			{:else if item.kind === 'bookmark'}
				{@const bookmark = item.bookmark}
				<div class="border-b border-border">
					<Item.Root size="sm" class="hover:bg-accent/50">
						<Item.Media> <TabFavicon src={bookmark.favIconUrl} /> </Item.Media>

						<Item.Content>
							<Item.Title>
								<span class="truncate">{bookmark.title || 'Untitled'}</span>
							</Item.Title>
							<Item.Description
								class="flex min-w-0 items-center gap-2 truncate"
							>
								<span class="truncate">{getDomain(bookmark.url)}</span>
								<span>•</span>
								<span class="shrink-0"
									>{getRelativeTime(bookmark.createdAt)}</span
								>
							</Item.Description>
						</Item.Content>

						<Item.Actions showOnHover class="gap-1">
							<Button
								variant="ghost"
								size="icon-xs"
								tooltip="Open"
								onclick={() => tabManager.state.bookmarks.open(bookmark).then((r) => toastOnError(r, 'Failed to open bookmark'))}
							>
								<ExternalLinkIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								class="text-destructive"
								tooltip="Delete"
								onclick={() => tabManager.state.bookmarks.remove(bookmark.id)}
							>
								<Trash2Icon />
							</Button>
						</Item.Actions>
					</Item.Root>
				</div>
			{/if}
		{/snippet}
	</VList>
{/if}
