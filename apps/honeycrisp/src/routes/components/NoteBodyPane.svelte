<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import HoneycrispEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrisp } from '$lib/app.svelte.js';

	const honeycrisp = getHoneycrisp();

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	type Opened = ReturnType<typeof honeycrisp.notes.openBody>;

	// The note's prose, per note. Nothing is loaded: the prose is a nested type
	// on the row in the document this store already holds (ADR-0295), so there
	// is no half-hydrated state an editor could merge keystrokes into, and
	// edits from every device reach it live through the one store connection.
	// What the pane still owns is the write the open starts: `close` stops the
	// title and `updatedAt` writes that follow this note's body.
	let opened = $state.raw<Opened>(undefined);
	$effect(() => {
		const handle = honeycrisp.notes.openBody(noteId);
		opened = handle;
		return () => handle?.close();
	});
</script>

{#if opened === undefined}
	<div class="flex h-full items-center justify-center p-6 text-center">
		<p class="text-sm text-muted-foreground">This note is no longer here.</p>
	</div>
{:else}
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			{#key noteId}
				<HoneycrispEditor yxmlfragment={opened.body} {focusRequest} />
			{/key}
		</div>
	</div>
{/if}
