<script lang="ts">
	import { NOTE_BODY, type NoteId } from '@epicenter/honeycrisp';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrisp } from '$lib/honeycrisp/index.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	const honeycrisp = getHoneycrisp();

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	// The note's prose, live. There is no lease to open, nothing to await, and
	// nothing to poll: the root was allocated with the row (ADR-0215), it lives
	// in the application's one document, and every device's edits reach it
	// through the transport like any other change. The editor binds to it
	// directly, which is what `document-polling.ts` and its one-second interval
	// existed to fake.
	const body = $derived(honeycrisp.tables.notes.document(noteId)?.get(NOTE_BODY));
</script>

{#if body === undefined}
	<div class="flex h-full items-center justify-center p-6 text-center">
		<p class="text-sm text-muted-foreground">This note is no longer here.</p>
	</div>
{:else}
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			{#key noteId}
				<HoneycripEditor
					yxmlfragment={body}
					{focusRequest}
					onContentChange={(change) =>
						runHoneycrispMutation(
							() => honeycrisp.notes.updateContent(noteId, change),
							'Could not save note',
						)}
				/>
			{/key}
		</div>
	</div>
{/if}
