<script lang="ts">
	import type { Note } from '@epicenter/honeycrisp';
	import { Button } from '@epicenter/ui/button';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { getHoneycrisp } from '$lib/honeycrisp/index.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';
	import { getDateLabel } from '$lib/utils/date';
	import NoteCard from '../components/NoteCard.svelte';

	const honeycrisp = getHoneycrisp();

	// Grouping only: `view.currentNotes` already owns the order (newest edit
	// first), so the pinned partition and the date labels preserve it.
	const groupedNotes = $derived.by(() => {
		const notes = honeycrisp.view.currentNotes;
		const pinned = notes.filter((n) => n.pinned);
		const unpinned = notes.filter((n) => !n.pinned);

		const groups: { label: string; entries: Note[] }[] = [];

		if (pinned.length > 0) {
			groups.push({ label: 'Pinned', entries: pinned });
		}

		let currentLabel = '';
		let currentGroup: Note[] = [];

		for (const note of unpinned) {
			const label = getDateLabel(note.updatedAt);
			if (label !== currentLabel) {
				if (currentGroup.length > 0) {
					groups.push({ label: currentLabel, entries: currentGroup });
				}
				currentLabel = label;
				currentGroup = [note];
			} else {
				currentGroup.push(note);
			}
		}

		if (currentGroup.length > 0) {
			groups.push({ label: currentLabel, entries: currentGroup });
		}

		return groups;
	});

	/** Flat list of note IDs in display order for arrow key navigation. */
	const flatNoteIds = $derived(
		groupedNotes.flatMap((g) => g.entries.map((n) => n.id)),
	);

	function createAndSelectNote(): void {
		const { id } = honeycrisp.notes.create(
			honeycrisp.view.selectedFolderId,
		);
		honeycrisp.view.selectNote(id);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flex h-full flex-col"
	onkeydown={(e) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		if (flatNoteIds.length === 0) return;
		e.preventDefault();

		const currentIndex = honeycrisp.view.selectedNoteId
			? flatNoteIds.indexOf(honeycrisp.view.selectedNoteId)
			: -1;

		if (e.key === 'ArrowDown') {
			const nextIndex =
				currentIndex < flatNoteIds.length - 1 ? currentIndex + 1 : 0;
			honeycrisp.view.selectNote(flatNoteIds[nextIndex]!);
		} else {
			const prevIndex =
				currentIndex > 0 ? currentIndex - 1 : flatNoteIds.length - 1;
			honeycrisp.view.selectNote(flatNoteIds[prevIndex]!);
		}
	}}
	tabindex="-1"
>
	<div class="flex items-center justify-between border-b px-4 py-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">
				{honeycrisp.view.currentTitle}
			</h2>
			<span class="text-xs text-muted-foreground"
				>{honeycrisp.view.currentNotes.length}</span
			>
		</div>
		{#if honeycrisp.view.currentShowControls}
			<div class="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={() =>
						runHoneycrispMutation(
							() => createAndSelectNote(),
							'Could not create note',
						)}
				>
					<PlusIcon class="size-4" />
				</Button>
			</div>
		{/if}
	</div>

	<ScrollArea.Root class="flex-1">
		{#if honeycrisp.view.currentNotes.length === 0}
			<div
				class="flex h-full items-center justify-center p-8 text-center text-muted-foreground"
			>
				<p class="text-sm">{honeycrisp.view.currentEmptyMessage}</p>
			</div>
		{:else}
			<div class="flex flex-col gap-4 p-2">
				{#each groupedNotes as group}
					<div class="flex flex-col gap-0.5">
						<h3 class="px-2 pb-1 text-xs font-medium text-muted-foreground">
							{group.label}
						</h3>
						{#each group.entries as note (note.id)}
							<NoteCard
								{note}
								isSelected={note.id === honeycrisp.view.selectedNoteId}
								onSelect={() => honeycrisp.view.selectNote(note.id)}
							/>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</ScrollArea.Root>
</div>
