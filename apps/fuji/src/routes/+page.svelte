<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { dateTimeStringNow, generateId } from '@epicenter/workspace';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import type * as Y from 'yjs';
	import EntriesTable from '$lib/components/EntriesTable.svelte';
	import EntryEditor from '$lib/components/EntryEditor.svelte';
	import EntryTimeline from '$lib/components/EntryTimeline.svelte';
	import FujiSidebar from '$lib/components/FujiSidebar.svelte';
	import workspaceClient, { type Entry, type EntryId } from '$lib/workspace';

	// ─── Reactive State ────────────────────────────────────────────────────────────

	let entries = $state<Entry[]>([]);
	let selectedEntryId = $state<EntryId | null>(null);
	let viewMode = $state<'table' | 'timeline'>('table');
	let currentYText = $state<Y.Text | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);

	// ─── Filters ─────────────────────────────────────────────────────────────────

	let activeTypeFilter = $state<string | null>(null);
	let activeTagFilter = $state<string | null>(null);
	let searchQuery = $state('');

	// ─── Workspace Observation ───────────────────────────────────────────────────

	$effect(() => {
		entries = workspaceClient.tables.entries.getAllValid();

		const kvEntryId = workspaceClient.kv.get('selectedEntryId');
		selectedEntryId = kvEntryId.status === 'valid' ? kvEntryId.value : null;

		const kvViewMode = workspaceClient.kv.get('viewMode');
		viewMode = kvViewMode.status === 'valid' ? kvViewMode.value : 'table';

		const unsubEntries = workspaceClient.tables.entries.observe(() => {
			entries = workspaceClient.tables.entries.getAllValid();
		});

		const unsubSelectedEntry = workspaceClient.kv.observe(
			'selectedEntryId',
			(change) => {
				selectedEntryId = change.type === 'set' ? change.value : null;
			},
		);

		const unsubViewMode = workspaceClient.kv.observe('viewMode', (change) => {
			viewMode = change.type === 'set' ? change.value : 'table';
		});

		return () => {
			unsubEntries();
			unsubSelectedEntry();
			unsubViewMode();
		};
	});

	// ─── Derived State ───────────────────────────────────────────────────────────

	const selectedEntry = $derived(
		entries.find((e) => e.id === selectedEntryId) ?? null,
	);

	/** Entries filtered by sidebar type/tag filters. */
	const filteredEntries = $derived.by(() => {
		let result = entries;
		const typeFilter = activeTypeFilter;
		const tagFilter = activeTagFilter;
		if (typeFilter) {
			result = result.filter((e) => e.type?.includes(typeFilter));
		}
		if (tagFilter) {
			result = result.filter((e) => e.tags?.includes(tagFilter));
		}
		return result;
	});

	// ─── Actions ─────────────────────────────────────────────────────────────────

	function createEntry() {
		const id = generateId() as unknown as EntryId;
		workspaceClient.tables.entries.set({
			id,
			title: '',
			preview: '',
			createdAt: dateTimeStringNow(),
			updatedAt: dateTimeStringNow(),
			_v: 2,
		});
		workspaceClient.kv.set('selectedEntryId', id);
	}

	function toggleViewMode() {
		const next = viewMode === 'table' ? 'timeline' : 'table';
		workspaceClient.kv.set('viewMode', next);
	}

	// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

	function handleKeydown(event: KeyboardEvent) {
		const isInputFocused =
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			(event.target instanceof HTMLElement && event.target.isContentEditable);

		if (event.key === 'n' && event.metaKey) {
			event.preventDefault();
			createEntry();
			return;
		}

		if (event.key === 'Escape' && !isInputFocused && selectedEntryId) {
			event.preventDefault();
			workspaceClient.kv.set('selectedEntryId', null);
		}
	}

	// ─── Document Handle (Y.Text) ────────────────────────────────────────────────

	$effect(() => {
		const entryId = selectedEntryId;
		if (!entryId) {
			currentYText = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspaceClient.documents.entries.body.open(entryId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYText = handle.asText();
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspaceClient.documents.entries.body.close(entryId);
			}
			currentYText = null;
			currentDocHandle = null;
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<SidebarProvider>
	<FujiSidebar
		{entries}
		{activeTypeFilter}
		{activeTagFilter}
		{searchQuery}
		onFilterByType={(type) => (activeTypeFilter = type)}
		onFilterByTag={(tag) => (activeTagFilter = tag)}
		onSearchChange={(query) => (searchQuery = query)}
		onSelectEntry={(id) => workspaceClient.kv.set('selectedEntryId', id)}
	/>

	<main class="flex h-screen flex-1 flex-col overflow-hidden">
		{#if selectedEntry && currentYText}
			{#key selectedEntryId}
				<EntryEditor
					entry={selectedEntry}
					ytext={currentYText}
					onUpdateEntry={(updates) => {
						if (!selectedEntryId) return;
						workspaceClient.tables.entries.update(selectedEntryId, updates);
					}}
					onPreviewChange={(preview) => {
						if (!selectedEntryId) return;
						workspaceClient.tables.entries.update(selectedEntryId, { preview });
					}}
					onBack={() => workspaceClient.kv.set('selectedEntryId', null)}
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
					onclick={toggleViewMode}
					title={viewMode === 'table' ? 'Switch to timeline' : 'Switch to table'}
				>
					{#if viewMode === 'table'}
						<ClockIcon class="size-4" />
					{:else}
						<TableIcon class="size-4" />
					{/if}
				</Button>
			</div>

			{#if viewMode === 'table'}
				<EntriesTable
					entries={filteredEntries}
					globalFilter={searchQuery}
					{selectedEntryId}
					onSelectEntry={(id) => workspaceClient.kv.set('selectedEntryId', id)}
					onAddEntry={createEntry}
				/>
			{:else}
				<EntryTimeline
					entries={filteredEntries}
					{selectedEntryId}
					onSelectEntry={(id) => workspaceClient.kv.set('selectedEntryId', id)}
					onAddEntry={createEntry}
				/>
			{/if}
		{/if}
	</main>
</SidebarProvider>
