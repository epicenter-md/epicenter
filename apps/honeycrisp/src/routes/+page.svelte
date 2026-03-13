<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import { SidebarProvider } from '@epicenter/ui/sidebar';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { dateTimeStringNow, generateId } from '@epicenter/workspace';
	import type * as Y from 'yjs';
	import HoneycripEditor from '$lib/components/Editor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
	import HoneycripSidebar from '$lib/components/Sidebar.svelte';
	import workspaceClient, {
		type Folder,
		type FolderId,
		type Note,
		type NoteId,
	} from '$lib/workspace';

	// ─── Reactive State ──────────────────────────────────────────────────────

	let folders = $state<Folder[]>([]);
	let notes = $state<Note[]>([]);
	let selectedFolderId = $state<FolderId | null>(null);
	let selectedNoteId = $state<NoteId | null>(null);
	let currentYXmlFragment = $state<Y.XmlFragment | null>(null);
	let currentDocHandle = $state<DocumentHandle | null>(null);
	let searchQuery = $state('');
	let sortBy = $state<'dateEdited' | 'dateCreated' | 'title'>('dateEdited');

	// ─── Workspace Observation ───────────────────────────────────────────────

	$effect(() => {
		folders = workspaceClient.tables.folders.getAllValid();
		notes = workspaceClient.tables.notes.getAllValid();

		selectedFolderId = workspaceClient.kv.get('selectedFolderId');
		selectedNoteId = workspaceClient.kv.get('selectedNoteId');
		sortBy = workspaceClient.kv.get('sortBy');

		const unsubFolders = workspaceClient.tables.folders.observe(() => {
			folders = workspaceClient.tables.folders.getAllValid();
		});
		const unsubNotes = workspaceClient.tables.notes.observe(() => {
			notes = workspaceClient.tables.notes.getAllValid();
		});
		const unsubFolderKv = workspaceClient.kv.observe(
			'selectedFolderId',
			(change) => {
				selectedFolderId = change.type === 'set' ? change.value : null;
			},
		);
		const unsubNoteKv = workspaceClient.kv.observe(
			'selectedNoteId',
			(change) => {
				selectedNoteId = change.type === 'set' ? change.value : null;
			},
		);
		const unsubSortByKv = workspaceClient.kv.observe('sortBy', (change) => {
			sortBy = change.type === 'set' ? change.value : 'dateEdited';
		});

		return () => {
			unsubFolders();
			unsubNotes();
			unsubFolderKv();
			unsubNoteKv();
			unsubSortByKv();
		};
	});

	// ─── Derived State ───────────────────────────────────────────────────────

	/** Notes filtered by selected folder and search query. */
	const filteredNotes = $derived.by(() => {
		let result =
			selectedFolderId === null
				? notes
				: notes.filter((n) => n.folderId === selectedFolderId);
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			result = result.filter(
				(n) =>
					n.title.toLowerCase().includes(q) ||
					n.preview.toLowerCase().includes(q),
			);
		}
		// Apply sort
		result = [...result].sort((a, b) => {
			if (sortBy === 'title') return a.title.localeCompare(b.title);
			if (sortBy === 'dateCreated')
				return b.createdAt.localeCompare(a.createdAt);
			return b.updatedAt.localeCompare(a.updatedAt);
		});
		return result;
	});

	/** Per-folder note counts for the sidebar. */
	const noteCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of notes) {
			if (note.folderId) {
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
			}
		}
		return counts;
	});

	const selectedNote = $derived(
		notes.find((n) => n.id === selectedNoteId) ?? null,
	);

	// ─── Document Handle (Y.XmlFragment) ────────────────────────────────────────────

	$effect(() => {
		const noteId = selectedNoteId;
		if (!noteId) {
			currentYXmlFragment = null;
			currentDocHandle = null;
			return;
		}

		let cancelled = false;
		workspaceClient.documents.notes.body.open(noteId).then((handle) => {
			if (cancelled) return;
			currentDocHandle = handle;
			currentYXmlFragment = handle.ydoc.getXmlFragment('content');
		});

		return () => {
			cancelled = true;
			if (currentDocHandle) {
				workspaceClient.documents.notes.body.close(noteId);
			}
			currentYXmlFragment = null;
			currentDocHandle = null;
		};
	});

	// ─── Actions ─────────────────────────────────────────────────────────────

	function createFolder() {
		const id = generateId() as unknown as FolderId;
		const sortOrder = folders.length;
		workspaceClient.tables.folders.set({
			id,
			name: 'New Folder',
			sortOrder,
			_v: 1,
		});
	}

	function renameFolder(folderId: FolderId, name: string) {
		workspaceClient.tables.folders.update(folderId, { name });
	}

	function deleteFolder(folderId: FolderId) {
		// Move notes in this folder to unfiled
		const folderNotes = notes.filter((n) => n.folderId === folderId);
		for (const note of folderNotes) {
			workspaceClient.tables.notes.update(note.id, {
				folderId: undefined,
			});
		}

		workspaceClient.tables.folders.delete(folderId);

		// If deleted folder was selected, go to All Notes
		if (selectedFolderId === folderId) {
			workspaceClient.kv.set('selectedFolderId', null);
		}
	}

	function createNote() {
		const id = generateId() as unknown as NoteId;
		workspaceClient.tables.notes.set({
			id,
			folderId: selectedFolderId ?? undefined,
			title: '',
			preview: '',
			pinned: false,
			createdAt: dateTimeStringNow(),
			updatedAt: dateTimeStringNow(),
			_v: 1,
		});
		workspaceClient.kv.set('selectedNoteId', id);
	}

	function deleteNote(noteId: NoteId) {
		workspaceClient.tables.notes.delete(noteId);
		if (selectedNoteId === noteId) {
			workspaceClient.kv.set('selectedNoteId', null);
		}
	}

	function pinNote(noteId: NoteId) {
		const note = notes.find((n) => n.id === noteId);
		if (!note) return;
		workspaceClient.tables.notes.update(noteId, { pinned: !note.pinned });
	}

	function selectFolder(folderId: FolderId | null) {
		workspaceClient.kv.set('selectedFolderId', folderId);
		// Clear note selection when switching folders
		workspaceClient.kv.set('selectedNoteId', null);
	}

	function selectNote(noteId: NoteId) {
		workspaceClient.kv.set('selectedNoteId', noteId);
	}

	function handleContentChange({
		title,
		preview,
	}: {
		title: string;
		preview: string;
	}) {
		if (!selectedNoteId) return;
		workspaceClient.tables.notes.update(selectedNoteId, { title, preview });
	}

	// ─── Keyboard Shortcuts ──────────────────────────────────────────────────

	function handleKeydown(e: KeyboardEvent) {
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;

		if (e.key === 'n' && e.shiftKey) {
			// ⌘⇧N — New folder
			e.preventDefault();
			createFolder();
		} else if (e.key === 'n') {
			// ⌘N — New note
			e.preventDefault();
			createNote();
		} else if (e.key === 'b') {
			// ⌘B — Toggle sidebar (handled by SidebarProvider)
			// SidebarProvider already handles this via keyboard shortcut
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<SidebarProvider>
	<HoneycripSidebar
		{folders}
		{selectedFolderId}
		{noteCounts}
		totalNoteCount={notes.length}
		{searchQuery}
		onSelectFolder={selectFolder}
		onCreateFolder={createFolder}
		onRenameFolder={renameFolder}
		onDeleteFolder={deleteFolder}
		onSearchChange={(q) => (searchQuery = q)}
	/>

	<main class="flex h-screen flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={35} minSize={20} class="border-r">
				<NoteList
					notes={filteredNotes}
					{selectedNoteId}
					{sortBy}
					onSelectNote={selectNote}
					onCreateNote={createNote}
					onDeleteNote={deleteNote}
					onPinNote={pinNote}
					onSortChange={(v) => workspaceClient.kv.set('sortBy', v)}
				/>
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={65} minSize={30} class="flex flex-col">
				{#if selectedNote && currentYXmlFragment}
					{#key selectedNoteId}
						<HoneycripEditor
							yxmlfragment={currentYXmlFragment}
							onContentChange={handleContentChange}
						/>
					{/key}
				{:else if selectedNote}
					<div class="flex h-full items-center justify-center">
						<p class="text-muted-foreground">Loading editor…</p>
					</div>
				{:else}
					<div class="flex h-full items-center justify-center">
						<p class="text-muted-foreground">Select or create a note</p>
					</div>
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</main>
</SidebarProvider>
