<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { honeycrisp } from '$lib/honeycrisp';
	import CommandPalette from './components/CommandPalette.svelte';
	import NoteBodyPane from './components/NoteBodyPane.svelte';
	import NoteList from './components/NoteList.svelte';
	import HoneycripSidebar from './components/Sidebar.svelte';

	let commandPaletteOpen = $state(false);

	function isEditorTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && target.closest('.ProseMirror') !== null;
	}

	function focusSearch() {
		const input = document.querySelector<HTMLInputElement>(
			'[data-honeycrisp-search]',
		);
		input?.focus();
		input?.select();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;
		const key = e.key.toLowerCase();

		if (key === 'f' && e.altKey && !e.shiftKey) {
			e.preventDefault();
			commandPaletteOpen = false;
			focusSearch();
		} else if (key === 'k') {
			if (isEditorTarget(e.target)) return;
			e.preventDefault();
			commandPaletteOpen = !commandPaletteOpen;
		} else if (key === 'n' && e.shiftKey) {
			e.preventDefault();
			honeycrisp.state.folders.create();
		} else if (key === 'n') {
			e.preventDefault();
			const { id } = honeycrisp.state.notes.create(honeycrisp.state.view.selectedFolderId);
			honeycrisp.state.view.selectNote(id);
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
				{#if honeycrisp.state.view.selectedNote && honeycrisp.state.view.selectedNoteId}
					{#key honeycrisp.state.view.selectedNoteId}
						<NoteBodyPane noteId={honeycrisp.state.view.selectedNoteId} />
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

<CommandPalette bind:open={commandPaletteOpen} />
