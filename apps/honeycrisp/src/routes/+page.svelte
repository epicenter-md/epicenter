<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { getHoneycrispRuntime } from '$lib/context.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';
	import { createHoneycrispState, setNotesSurface } from './state/index.js';
	import CommandPalette from './components/CommandPalette.svelte';
	import NoteBodyPane from './components/NoteBodyPane.svelte';
	import NoteList from './components/NoteList.svelte';
	import HoneycripSidebar from './components/Sidebar.svelte';

	const runtime = getHoneycrispRuntime();

	// The surface chooses its document, once, here: account notes when this
	// generation has an account, device notes otherwise. The runtime carries no
	// default document, so this line is the whole of the choice, and a Local
	// Drafts surface would write `runtime.deviceData` in the same position.
	const data = runtime.account?.data ?? runtime.deviceData;
	const state = createHoneycrispState({ db: data });
	setNotesSurface({ data, state });
	$effect(() => () => state[Symbol.dispose]());

	function createAndSelectNote(): void {
		const { id } = state.notes.create(state.view.selectedFolderId);
		state.view.selectNote(id);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			runHoneycrispMutation(
				() => state.folders.create(),
				'Could not create folder',
			);
		} else if (e.key === 'n') {
			e.preventDefault();
			runHoneycrispMutation(() => createAndSelectNote(), 'Could not create note');
		}
	}}
/>

<SidebarProvider>
	<HoneycripSidebar />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if state.view.selectedNote && state.view.selectedNoteId}
					{#key state.view.selectedNoteId}
						<NoteBodyPane
							noteId={state.view.selectedNoteId}
							focusRequest={state.view.editorFocusRequest}
						/>
					{/key}
				{:else}
					<div class="flex h-full flex-col items-center justify-center gap-2">
						<p class="text-muted-foreground">No note selected</p>
						<p class="text-sm text-muted-foreground/60">
							Choose a note from the list or press ⌘N to create one
						</p>
					</div>
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</main>
</SidebarProvider>

<CommandPalette />
