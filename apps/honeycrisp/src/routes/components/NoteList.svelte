<script lang="ts">
	import type { Note } from '@epicenter/honeycrisp';
	import { Button } from '@epicenter/ui/button';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { navigation } from '$lib/navigation.svelte.js';
	import { getDateLabel } from '$lib/date-label.js';
	import NoteCard from '../components/NoteCard.svelte';

	const honeycrisp = getHoneycrisp();

	const title = $derived.by(() => {
		if (navigation.isDeletedView) return 'Recently Deleted';
		const folderId = navigation.folderId;
		if (folderId === null) return 'All Notes';
		return honeycrisp.folders.get(folderId)?.name ?? 'Notes';
	});

	/**
	 * What to say when the list is empty.
	 *
	 * "No notes yet" is a claim about the person's history, and it is false when
	 * the list is empty because this release cannot INTERPRET what they wrote. A
	 * note written by a newer release, or by a workspace this one has since
	 * changed, reads as `Nonconforming` (ADR-0125); the row is intact and
	 * unreadable, which is a different thing from absent and deserves a
	 * different sentence.
	 */
	const emptyMessage = $derived.by(() => {
		const unreadable = honeycrisp.notes.nonconforming.length;
		if (unreadable > 0) {
			const [subject, object] =
				unreadable === 1 ? ['note is', 'it'] : ['notes are', 'them'];
			return `${unreadable} ${subject} here but this version of Honeycrisp cannot read ${object}. Nothing has been lost.`;
		}
		return navigation.isDeletedView
			? 'No deleted notes'
			: 'No notes yet. Click + to create one.';
	});

	// Grouping only: `visibleNotes` already owns the order (newest edit first),
	// so the pinned partition and the date labels preserve it.
	const groupedNotes = $derived.by(() => {
		const notes = honeycrisp.visibleNotes;
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

</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flex h-full flex-col"
	onkeydown={(e) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		if (flatNoteIds.length === 0) return;
		e.preventDefault();

		const currentIndex = navigation.noteId
			? flatNoteIds.indexOf(navigation.noteId)
			: -1;

		if (e.key === 'ArrowDown') {
			const nextIndex =
				currentIndex < flatNoteIds.length - 1 ? currentIndex + 1 : 0;
			navigation.selectNote(flatNoteIds[nextIndex]!);
		} else {
			const prevIndex =
				currentIndex > 0 ? currentIndex - 1 : flatNoteIds.length - 1;
			navigation.selectNote(flatNoteIds[prevIndex]!);
		}
	}}
	tabindex="-1"
>
	<div class="flex items-center justify-between border-b px-4 py-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">
				{title}
			</h2>
			<span class="text-xs text-muted-foreground"
				>{honeycrisp.visibleNotes.length}</span
			>
		</div>
		{#if !navigation.isDeletedView}
			<div class="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={() =>
						honeycrisp.createNote()}
				>
					<PlusIcon class="size-4" />
				</Button>
			</div>
		{/if}
	</div>

	<ScrollArea.Root class="flex-1">
		{#if honeycrisp.visibleNotes.length === 0}
			<div
				class="flex h-full items-center justify-center p-8 text-center text-muted-foreground"
			>
				<p class="text-sm">{emptyMessage}</p>
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
								isSelected={note.id === navigation.noteId}
								onSelect={() => navigation.selectNote(note.id)}
							/>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</ScrollArea.Root>
</div>
