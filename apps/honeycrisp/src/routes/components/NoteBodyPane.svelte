<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrispApp } from '$lib/context.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';
	import DocumentSyncStatus from './DocumentSyncStatus.svelte';

	const honeycrisp = getHoneycrispApp();

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
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			<HoneycripEditor
				yxmlfragment={document.get('body')}
				{focusRequest}
				onContentChange={(change) =>
					runHoneycrispMutation(
						honeycrisp.state.notes.updateContent(noteId, change),
						'Could not save note',
					)}
			/>
		</div>
		<DocumentSyncStatus {document} />
	</div>
{/await}
