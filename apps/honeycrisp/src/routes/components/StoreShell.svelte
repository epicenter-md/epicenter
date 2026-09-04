<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { ReactiveData } from '@epicenter/svelte';
	import { createHoneycrisp, setHoneycrisp } from '$lib/app.svelte.js';
	import type { HoneycrispData } from '$lib/data';
	import { openWorkingCopy } from '#platform/folder';
	import { navigation } from '$lib/navigation.svelte.js';
	import CommandPalette from './CommandPalette.svelte';
	import NoteBodyPane from './NoteBodyPane.svelte';
	import NoteList from './NoteList.svelte';
	import HoneycrispSidebar from './Sidebar.svelte';

	// The opened store, awake, and everything a sidebar shows about it is read
	// off it. The route used to hand four props down, assembled by the opener it
	// owned; the store states its own address and its own connection now
	// (ADR-0340), and `fromEpicenter` adapted its reads before handing it over.
	let { data }: { data: ReactiveData<HoneycrispData> } = $props();

	// The application object is provided here rather than by a component whose
	// whole body was this line. `setContext` must run during initialisation, and
	// this component only mounts under `ready`, which is what carries "the store
	// is open" to every descendant without a type saying so.
	// Read once, not `$derived`: the route mounts this exactly once per opened
	// store, so `data` never changes while this component lives.
	/* svelte-ignore state_referenced_locally */
	const honeycrisp = setHoneycrisp(createHoneycrisp({ data }));

	// A denied connection renders the same as no connection at all: the store
	// opened from local state before a socket was attempted, and the status
	// line goes quiet rather than saying something is wrong.
	const syncStatus = () => {
		const status = data.sync.status();
		return status?.denied === false ? status : undefined;
	};
	// Nothing to construct in a build with no filesystem: the seam hands out
	// the capability rather than a flag, so a browser build has no working copy
	// and the components that take one are never mounted (ADR-0337).
	/* svelte-ignore state_referenced_locally */
	const folder = openWorkingCopy?.(data);
</script>

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			honeycrisp.tables.folders.create();
		} else if (e.key === 'n') {
			e.preventDefault();
			honeycrisp.createNote();
		}
	}}
/>

<SidebarProvider>
	<HoneycrispSidebar {syncStatus} {folder} />

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList hasFolder={folder !== undefined} />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if navigation.noteId}
					{#key navigation.noteId}
						<NoteBodyPane
							noteId={navigation.noteId}
							focusRequest={navigation.editorFocusRequest}
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
