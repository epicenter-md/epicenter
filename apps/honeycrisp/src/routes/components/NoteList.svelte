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
		return honeycrisp.tables.folders.get(folderId)?.name ?? 'Notes';
	});

	/**
	 * What to say when there is nothing at all to look at.
	 *
	 * "No notes yet" is a claim about the person's history, and it is only true
	 * when the unreadable group below is empty too: a note this release cannot
	 * INTERPRET is a row that is intact and present (ADR-0125), and it has its
	 * own group rather than a sentence standing in for the list.
	 */
	const emptyMessage = $derived(
		navigation.isDeletedView
			? 'No deleted notes'
			: 'No notes yet. Click + to create one.',
	);

	/**
	 * The notes in this table that this release cannot read (ADR-0125,
	 * ADR-0338).
	 *
	 * Shown as its own group rather than folded into the list, because there is
	 * nothing to open: the row is there, the values did not fit the declaration,
	 * and every verb the card offers reads a field that failed. A push from the
	 * folder can produce one on purpose, so one broken note among a hundred has
	 * to be visible with the ninety-nine rather than only when the list is
	 * otherwise empty.
	 *
	 * Unfiltered by the folder, the query, and the deleted view alike. Which of
	 * those a note belongs in is read off values this release could not read, so
	 * hiding it under any of them is how it becomes invisible again.
	 */
	const unreadableNotes = $derived(
		honeycrisp.tables.notes.nonconforming.map((row) => ({
			id: row.id,
			// The title as it was stored, which is the only name a person has for
			// this note, and only when it survived as a string.
			title: typeof row.raw.title === 'string' ? row.raw.title : '',
			issues: row.issues,
		})),
	);

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
					tooltip="New note"
					aria-label="New note"
					onclick={() =>
						honeycrisp.createNote()}
				>
					<PlusIcon class="size-4" />
				</Button>
			</div>
		{/if}
	</div>

	<ScrollArea.Root class="flex-1">
		{#if honeycrisp.visibleNotes.length === 0 && unreadableNotes.length === 0}
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

				<!--
					Last, and not selectable. There is no editor to open on a note whose
					values this release could not read, and the repair is the folder:
					fix the file and send it back.
				-->
				{#if unreadableNotes.length > 0}
					<div class="flex flex-col gap-0.5">
						<h3 class="px-2 pb-1 text-xs font-medium text-muted-foreground">
							This version cannot read
						</h3>
						{#each unreadableNotes as note (note.id)}
							<div class="rounded-lg px-3 py-2">
								<p class="line-clamp-1 text-sm font-medium">
									{note.title || note.id}
								</p>
								<ul class="mt-0.5 text-xs text-muted-foreground">
									{#each note.issues as issue (issue.field + issue.message)}
										<li>{issue.field}: {issue.message}</li>
									{/each}
								</ul>
							</div>
						{/each}
						<p class="px-3 pt-1 text-xs text-muted-foreground">
							Nothing has been lost. Save these notes as files, fix the lines
							above in your Epicenter folder, and send the edits back.
						</p>
					</div>
				{/if}
			</div>
		{/if}
	</ScrollArea.Root>
</div>
