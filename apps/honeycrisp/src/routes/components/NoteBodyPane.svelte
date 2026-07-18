<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { honeycrisp } from '$lib/honeycrisp';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	const lease = $derived(honeycrisp.tables.notes.document.open(noteId));
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
