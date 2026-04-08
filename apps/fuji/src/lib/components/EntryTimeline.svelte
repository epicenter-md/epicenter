<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { format, isToday, isYesterday } from 'date-fns';
	import type { Entry, EntryId } from '$lib/workspace';

	let {
		entries,
		selectedEntryId,
		onSelectEntry,
		onAddEntry,
	}: {
		entries: Entry[];
		selectedEntryId: EntryId | null;
		onSelectEntry: (id: EntryId) => void;
		onAddEntry: () => void;
	} = $props();

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}

	function getDateLabel(dts: string): string {
		const date = parseDateTime(dts);
		if (isToday(date)) return 'Today';
		if (isYesterday(date)) return 'Yesterday';
		return format(date, 'MMMM d');
	}

	/** Entries grouped by date label, sorted newest first. */
	const groupedEntries = $derived.by(() => {
		const sorted = [...entries].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		);

		const groups: { label: string; entries: Entry[] }[] = [];
		let currentLabel = '';
		let currentGroup: Entry[] = [];

		for (const entry of sorted) {
			const label = getDateLabel(entry.updatedAt);
			if (label !== currentLabel) {
				if (currentGroup.length > 0) {
					groups.push({ label: currentLabel, entries: currentGroup });
				}
				currentLabel = label;
				currentGroup = [entry];
			} else {
				currentGroup.push(entry);
			}
		}

		if (currentGroup.length > 0) {
			groups.push({ label: currentLabel, entries: currentGroup });
		}

		return groups;
	});
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between border-b px-4 py-3">
		<h2 class="text-sm font-semibold">Timeline</h2>
		<Button variant="ghost" size="icon" class="size-7" onclick={onAddEntry}>
			<PlusIcon class="size-4" />
		</Button>
	</div>

	<!-- Timeline -->
	<ScrollArea.Root class="flex-1">
		{#if entries.length === 0}
			<div
				class="flex h-full items-center justify-center p-8 text-center text-muted-foreground"
			>
				<div class="flex flex-col items-center gap-3">
					<p class="text-sm">No entries yet.</p>
					<Button variant="outline" size="sm" onclick={onAddEntry}>
						<PlusIcon class="mr-1 size-4" />
						Create your first entry
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-4 p-4">
				{#each groupedEntries as group}
					<div class="flex flex-col gap-1">
						<h3 class="px-2 text-xs font-medium text-muted-foreground">
							{group.label}
						</h3>
						{#each group.entries as entry (entry.id)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="group flex cursor-pointer flex-col gap-0.5 rounded-lg p-3 text-sm transition-colors hover:bg-accent/50 {selectedEntryId ===
								entry.id
									? 'bg-accent'
									: ''}"
								onclick={() => onSelectEntry(entry.id)}
							>
								<div class="flex items-start justify-between gap-2">
									<span class="font-medium line-clamp-1">
										{entry.title || 'Untitled'}
									</span>
									<span class="shrink-0 text-xs text-muted-foreground">
										{format(parseDateTime(entry.updatedAt), 'h:mm a')}
									</span>
								</div>
								{#if entry.subtitle}
									<p class="line-clamp-1 text-xs text-muted-foreground">
										{entry.subtitle}
									</p>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</ScrollArea.Root>
</div>
