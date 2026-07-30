<script lang="ts">
	import type { DocumentSyncIssue } from '@epicenter/data';
	import type { NoteId } from '@epicenter/honeycrisp';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrispApp } from '$lib/context.js';
	import { startNoteDocumentPolling } from '$lib/document-polling.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	const honeycrisp = getHoneycrispApp();

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	const lease = $derived(honeycrisp.openNoteDocument(noteId));
	let syncIssue = $state<DocumentSyncIssue>(null);
	$effect(() => {
		const openedLease = lease;
		syncIssue = null;
		let stopPolling: (() => void) | undefined;
		let stale = false;
		void openedLease.then((opened) => {
			if (stale) return;
			stopPolling = startNoteDocumentPolling(opened.document, {
				onIssue: (issue) => (syncIssue = issue),
			});
		}, () => undefined);
		return () => {
			stale = true;
			stopPolling?.();
			void openedLease.then(
				(opened) => opened[Symbol.asyncDispose](),
				() => undefined,
			);
		};
	});
</script>

{#await lease}
	<Loading class="h-full" />
{:then opened}
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			<HoneycripEditor
				yxmlfragment={opened.document.get('body')}
				{focusRequest}
				onContentChange={(change) =>
					runHoneycrispMutation(
						honeycrisp.state.notes.updateContent(noteId, change),
						'Could not save note',
					)}
			/>
		</div>
		{#if syncIssue?.kind === 'too-large'}
			<div
				class="flex items-center gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground"
			>
				<TriangleAlertIcon class="size-3.5 shrink-0" />
				<span>
					This note is too large to sync. It stays available on this device;
					copy its content into a new note to continue syncing.
				</span>
			</div>
		{/if}
	</div>
{/await}
