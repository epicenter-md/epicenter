<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { honeycrisp } from '$lib/honeycrisp';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	let documentGeneration = $state(0);
	const lease = $derived.by(() => {
		documentGeneration;
		return honeycrisp.tables.notes.document.open(noteId);
	});
	$effect(() =>
		honeycrisp.onDocumentsInvalidated(() => {
			documentGeneration += 1;
		}),
	);
	$effect(() => {
		const openedLease = lease;
		return () =>
			void openedLease.then(
				(opened) => opened[Symbol.dispose](),
				() => undefined,
			);
	});
</script>

{#await lease}
	<Loading class="h-full" />
{:then document}
	<HoneycripEditor
		yxmlfragment={document.get('body')}
		{focusRequest}
		onContentChange={(change) =>
			runHoneycrispMutation(
				honeycrisp.state.notes.updateContent(noteId, change),
				'Could not save note',
			)}
	/>
{/await}
