<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import HoneycrispEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrisp } from '$lib/app.svelte.js';

	const honeycrisp = getHoneycrisp();

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	type Opened = Awaited<ReturnType<typeof honeycrisp.notes.openBody>>;

	// The note's prose, opened per note. The open resolves only after complete
	// local hydration (ADR-0248), so the editor never binds to a half-hydrated
	// document and never merges keystrokes at the wrong position; edits from
	// every device reach the open document live through the one store
	// connection. The pane owns the handle: switching notes or unmounting
	// closes the previous document, which is what lets the store unload it.
	let opened = $state.raw<Opened | 'loading'>('loading');
	$effect(() => {
		let stale = false;
		opened = 'loading';
		void honeycrisp.notes.openBody(noteId).then((handle) => {
			if (stale) {
				handle?.close();
				return;
			}
			opened = handle;
		});
		return () => {
			stale = true;
			if (opened !== 'loading') opened?.close();
		};
	});
</script>

{#if opened === 'loading'}
	<!-- Hydration is a local read; a blank pane beats a flash of message. -->
	<div class="h-full"></div>
{:else if opened === undefined}
	<div class="flex h-full items-center justify-center p-6 text-center">
		<p class="text-sm text-muted-foreground">This note is no longer here.</p>
	</div>
{:else}
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			{#key noteId}
				<HoneycrispEditor
					yxmlfragment={opened.body}
					{focusRequest}
					onContentChange={(change) =>
						honeycrisp.notes.updateContent(noteId, change)}
				/>
			{/key}
		</div>
	</div>
{/if}
