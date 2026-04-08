<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import { toastOnError } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { cn } from '@epicenter/ui/utils';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import StarIcon from '@lucide/svelte/icons/star';
	import Volume2Icon from '@lucide/svelte/icons/volume-2';
	import VolumeXIcon from '@lucide/svelte/icons/volume-x';
	import XIcon from '@lucide/svelte/icons/x';
	import { bookmarkState } from '$lib/state/bookmark-state.svelte';
	import {
		type BrowserTab,
		browserState,
	} from '$lib/state/browser-state.svelte';
	import { savedTabState } from '$lib/state/saved-tab-state.svelte';
	import { getDomain } from '$lib/utils/format';
	import TabFavicon from './TabFavicon.svelte';

	let { tab }: { tab: BrowserTab } = $props();

	const domain = $derived(tab.url ? getDomain(tab.url) : '');
	const isBookmarked = $derived(bookmarkState.isUrlBookmarked(tab.url));
</script>

<Item.Root
	size="sm"
	class={cn(
		'w-full text-left',
		tab.active ? 'bg-accent/50' : 'hover:bg-accent',
	)}
>
	{#snippet child({ props }: { props: Record<string, unknown> })}
		<button
			type="button"
			{...props}
			onclick={() => browserState.activate(tab.id)}
		>
			<Item.Media> <TabFavicon src={tab.favIconUrl} /> </Item.Media>

			<Item.Content>
				<Item.Title>
					{#if tab.pinned}
						<PinIcon class="size-3 shrink-0 text-muted-foreground" />
					{/if}
					{#if tab.audible && !tab.mutedInfo?.muted}
						<Volume2Icon class="size-3 shrink-0 text-muted-foreground" />
					{/if}
					{#if tab.mutedInfo?.muted}
						<VolumeXIcon class="size-3 shrink-0 text-muted-foreground" />
					{/if}
					<span class="truncate">{tab.title || 'Untitled'}</span>
				</Item.Title>
				{#if tab.url}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props }: { props: Record<string, unknown> })}
								<Item.Description {...props} class="w-fit truncate">
									{domain}
								</Item.Description>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content
							side="bottom"
							collisionPadding={8}
							class="max-w-[calc(100vw-2rem)] break-all"
						>
							{tab.url}
						</Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<Item.Description class="truncate"> {domain} </Item.Description>
				{/if}
			</Item.Content>

			<Item.Actions showOnHover class="gap-1">
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip={tab.pinned ? 'Unpin' : 'Pin'}
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						if (tab.pinned) {
						browserState.unpin(tab.id);
						} else {
						browserState.pin(tab.id);
						}
					}}
				>
					{#if tab.pinned}
						<PinOffIcon />
					{:else}
						<PinIcon />
					{/if}
				</Button>

				{#if tab.audible || tab.mutedInfo?.muted}
					<Button
						variant="ghost"
						size="icon-xs"
						tooltip={tab.mutedInfo?.muted ? 'Unmute' : 'Mute'}
						onclick={(e: MouseEvent) => {
							e.stopPropagation();
							if (tab.mutedInfo?.muted) {
							browserState.unmute(tab.id);
							} else {
							browserState.mute(tab.id);
							}
						}}
					>
						{#if tab.mutedInfo?.muted}
							<Volume2Icon />
						{:else}
							<VolumeXIcon />
						{/if}
					</Button>
				{/if}

				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="Reload"
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						browserState.reload(tab.id);
					}}
				>
					<RefreshCwIcon />
				</Button>

				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="Duplicate"
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						browserState.duplicate(tab.id);
					}}
				>
					<CopyIcon />
				</Button>

				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="Save for later"
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						savedTabState.save(tab).then(toastOnError);
					}}
				>
					<ArchiveIcon />
				</Button>

				<Button
					variant="ghost"
					size="icon-xs"
					tooltip={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						bookmarkState.toggle(tab).then(toastOnError);
					}}
				>
					<StarIcon
						class={isBookmarked ? 'fill-amber-500 text-amber-500' : ''}
					/>
				</Button>

				<Button
					variant="ghost"
					size="icon-xs"
					class="text-destructive"
					tooltip="Close"
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						browserState.close(tab.id);
					}}
				>
					<XIcon />
				</Button>
			</Item.Actions>
		</button>
	{/snippet}
</Item.Root>
