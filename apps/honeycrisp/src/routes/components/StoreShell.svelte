<script lang="ts">
	import type { SyncConnectionStatus } from '@epicenter/data/sync';
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { navigation } from '$lib/navigation.svelte.js';
	import CommandPalette from './CommandPalette.svelte';
	import NoteBodyPane from './NoteBodyPane.svelte';
	import NoteList from './NoteList.svelte';
	import HoneycrispSidebar from './Sidebar.svelte';

	let {
		storeLabel,
		otherStoreLabel,
		otherStoreHref,
		syncStatus,
	}: {
		storeLabel: 'On this device' | 'Across your devices';
		otherStoreLabel: 'On this device' | 'Across your devices';
		otherStoreHref: '/device' | '/account';
		syncStatus?: () => SyncConnectionStatus | undefined;
	} = $props();

	const honeycrisp = getHoneycrisp();
</script>

<svelte:window
	onkeydown={(e) => {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			e.preventDefault();
			honeycrisp.folders.create();
		} else if (e.key === 'n') {
			e.preventDefault();
			honeycrisp.createNote();
		}
	}}
/>

<SidebarProvider>
	<HoneycrispSidebar
		{syncStatus}
		{storeLabel}
		{otherStoreLabel}
		{otherStoreHref}
	/>

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20}>
				<NoteList />
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
