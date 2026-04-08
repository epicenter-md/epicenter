<script lang="ts">
	import { fromKv, fromTable } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { dateTimeStringNow, generateId } from '@epicenter/workspace';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import type * as Y from 'yjs';
	import { workspace } from '$lib/client';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntryEditor from '$lib/components/EntryEditor.svelte';
	import EntryTimeline from '$lib/components/EntryTimeline.svelte';
	import FujiSidebar from '$lib/components/FujiSidebar.svelte';
	import type { Entry, EntryId } from '$lib/workspace';

	// ─── Reactive State ────────────────────────────────────────────────────────────

	const entries = fromTable(workspace.tables.entries);
	const entriesArray = $derived(entries.values().toArray());
	const selectedEntryId = fromKv(workspace.kv, 'selectedEntryId');
	const viewMode = fromKv(workspace.kv, 'viewMode');
	let currentYText = $state<Y.Text | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	// ─── Filters ─────────────────────────────────────────────────────────────────

	let activeTypeFilter = $state<string | null>(null);
	let activeTagFilter = $state<string | null>(null);
	let searchQuery = $state('');

	// ─── Derived State ───────────────────────────────────────────────────────────

	const selectedEntry = $derived(
		selectedEntryId.current
			? (entries.get(selectedEntryId.current) ?? null)
			: null,
	);

	/** Entries filtered by sidebar type/tag filters. */
	const filteredEntries = $derived.by(() => {
		let result = entriesArray;
		const typeFilter = activeTypeFilter;
		const tagFilter = activeTagFilter;
		if (typeFilter) {
			result = result.filter((e) => e.type.includes(typeFilter));
		}
		if (tagFilter) {
			result = result.filter((e) => e.tags.includes(tagFilter));
		}
		return result;
	});

	// ─── Actions ─────────────────────────────────────────────────────────────────

	function createEntry() {
		const id = generateId() as unknown as EntryId;
		workspace.tables.entries.set({
			id,
			title: '',
			subtitle: '',
			type: [],
			tags: [],
			createdAt: dateTimeStringNow(),
			updatedAt: dateTimeStringNow(),
			_v: '1',
		});
		selectedEntryId.current = id;
	}

	// ─── Document Handle (Y.Text) ────────────────────────────────────────────────

	$effect(() => {
		const entryId = selectedEntryId.current;
		if (!entryId) {
			currentYText = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspace.documents.entries.content.open(entryId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYText = handle.asText();
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspace.documents.entries.content.close(entryId);
			}
			currentYText = null;
			currentDocHandle = null;
		};
	});
</script>

<svelte:window
	onkeydown={(event) => {
	const isInputFocused =
		event.target instanceof HTMLInputElement ||
		event.target instanceof HTMLTextAreaElement ||
		(event.target instanceof HTMLElement && event.target.isContentEditable);

	if (event.key === 'n' && event.metaKey) {
		event.preventDefault();
		createEntry();
		return;
	}

	if (event.key === 'Escape' && !isInputFocused && selectedEntryId.current) {
		event.preventDefault();
		selectedEntryId.current = null;
	}
}}
/>

<SidebarProvider>
	<FujiSidebar
		entries={entriesArray}
		{activeTypeFilter}
		{activeTagFilter}
		{searchQuery}
		onFilterByType={(type) => (activeTypeFilter = type)}
		onFilterByTag={(tag) => (activeTagFilter = tag)}
		onSearchChange={(query) => (searchQuery = query)}
		onSelectEntry={(id) => (selectedEntryId.current = id)}
	/>

	<main class="flex h-screen flex-1 flex-col overflow-hidden">
		{#if selectedEntry && currentYText}
			{#key selectedEntryId.current}
				<EntryEditor
					entry={selectedEntry}
					ytext={currentYText}
					onUpdate={(updates) => {
						if (!selectedEntryId.current) return;
						workspace.tables.entries.update(selectedEntryId.current, updates);
					}}
					onBack={() => (selectedEntryId.current = null)}
				/>
			{/key}
		{:else if selectedEntry}
			<div class="flex h-full items-center justify-center">
				<p class="text-muted-foreground">Loading editor\u2026</p>
			</div>
		{:else}
			<!-- View mode toggle header -->
			<div class="flex items-center justify-end border-b px-4 py-2">
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={() => (viewMode.current = viewMode.current === 'table' ? 'timeline' : 'table')}
					title={viewMode.current === 'table' ? 'Switch to timeline' : 'Switch to table'}
				>
					{#if viewMode.current === 'table'}
						<ClockIcon class="size-4" />
					{:else}
						<TableIcon class="size-4" />
					{/if}
				</Button>
			</div>

			{#if viewMode.current === 'table'}
				<EntriesTable
					entries={filteredEntries}
					{searchQuery}
					selectedEntryId={selectedEntryId.current}
					onSelectEntry={(id) => (selectedEntryId.current = id)}
					onAddEntry={createEntry}
				/>
			{:else}
				<EntryTimeline
					entries={filteredEntries}
					selectedEntryId={selectedEntryId.current}
					onSelectEntry={(id) => (selectedEntryId.current = id)}
					onAddEntry={createEntry}
				/>
			{/if}
		{/if}
	</main>
</SidebarProvider>
