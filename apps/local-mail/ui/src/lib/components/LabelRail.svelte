<script lang="ts">
	import { Input } from '@epicenter/ui/input';
	import { cn } from '@epicenter/ui/utils';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MailsIcon from '@lucide/svelte/icons/mails';
	import SearchIcon from '@lucide/svelte/icons/search';
	import StarIcon from '@lucide/svelte/icons/star';
	import TagIcon from '@lucide/svelte/icons/tag';
	import type { Component } from 'svelte';
	import { labelDisplayName } from '$lib/format';
	import type { MailLabel } from '$lib/types';

	let {
		labels,
		selectedLabel,
		search,
		onSelect,
		onSearch,
	}: {
		labels: MailLabel[];
		selectedLabel: string | null;
		search: string;
		onSelect: (id: string | null) => void;
		onSearch: (value: string) => void;
	} = $props();

	type Quick = { id: string | null; label: string; icon: Component };
	const quick: Quick[] = [
		{ id: null, label: 'All mail', icon: MailsIcon },
		{ id: 'INBOX', label: 'Inbox', icon: InboxIcon },
		{ id: 'UNREAD', label: 'Unread', icon: MailIcon },
		{ id: 'STARRED', label: 'Starred', icon: StarIcon },
	];

	const categories = $derived(
		labels.filter((l) => l.id.startsWith('CATEGORY_')),
	);
	const userLabels = $derived(labels.filter((l) => l.type === 'user'));
</script>

<nav class="flex w-56 shrink-0 flex-col border-r border-border bg-background">
	<div class="border-b border-border p-2">
		<div class="relative">
			<SearchIcon
				class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				id="mirror-search"
				value={search}
				oninput={(e) => onSearch(e.currentTarget.value)}
				placeholder="Search mirror"
				class="h-8 pl-7 text-xs"
			/>
		</div>
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto p-2">
		<ul class="space-y-0.5">
			{#each quick as item (item.label)}
				{@const Icon = item.icon}
				<li>
					<button
						class={cn(
							'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
							selectedLabel === item.id
								? 'bg-accent font-medium text-accent-foreground'
								: 'text-foreground/80 hover:bg-accent/50',
						)}
						onclick={() => onSelect(item.id)}
					>
						<Icon class="size-4 shrink-0 text-muted-foreground" />
						<span class="truncate">{item.label}</span>
					</button>
				</li>
			{/each}
		</ul>

		{#if categories.length}
			<p class="px-2 pb-1 pt-4 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
				Categories
			</p>
			<ul class="space-y-0.5">
				{#each categories as label (label.id)}
					<li>
						<button
							class={cn(
								'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
								selectedLabel === label.id
									? 'bg-accent font-medium text-accent-foreground'
									: 'text-foreground/80 hover:bg-accent/50',
							)}
							onclick={() => onSelect(label.id)}
						>
							<TagIcon class="size-4 shrink-0 text-muted-foreground" />
							<span class="truncate">{labelDisplayName(label.id, label.name)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if userLabels.length}
			<p class="px-2 pb-1 pt-4 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
				Labels
			</p>
			<ul class="space-y-0.5">
				{#each userLabels as label (label.id)}
					<li>
						<button
							class={cn(
								'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
								selectedLabel === label.id
									? 'bg-accent font-medium text-accent-foreground'
									: 'text-foreground/80 hover:bg-accent/50',
							)}
							onclick={() => onSelect(label.id)}
						>
							<TagIcon class="size-4 shrink-0 text-muted-foreground" />
							<span class="truncate">{labelDisplayName(label.id, label.name)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</nav>
