import type { UpdateRowError } from '@epicenter/data';
import { InstantString } from '@epicenter/field';
import {
	deleteHoneycrispFolder,
	type FolderId,
	type HoneycrispData,
	NOTE_BODY,
	type Note,
	type NoteId,
} from '@epicenter/honeycrisp';
import { fromWorkspace, type ReactiveWorkspace } from '@epicenter/svelte';
import { createContext } from 'svelte';
import type { HoneycrispDatabases } from './databases.js';
import { navigation } from './navigation.svelte.js';
import { readNoteText } from './note-text.js';

/**
 * The reactive Honeycrisp application, for one mounted app generation.
 *
 * The databases are boot's yield: opened documents, attached sync, and the
 * disposal that closes them (ADR-0233). This is the application built on top
 * of them, and the one object the UI consumes. It owns the document-selection
 * policy, the reactive named tables over that document (`fromWorkspace`),
 * Honeycrisp's domain operations (`notes`, `folders`), the one derivation that
 * needs both those tables and where the user is (`visibleNotes`), and the
 * narrow account and store capabilities the UI actually needs.
 *
 * The tables themselves do not cross this boundary either. `notes` and
 * `folders` are the whole vocabulary a component gets, so nothing downstream
 * can reach a raw write verb, the `kv` root, or the other table. That was not
 * true until recently: `tables` was exposed so one editor pane could reach one
 * note's prose, and it now asks for that by name (`notes.body`).
 *
 * Where the user is looking is deliberately NOT here. That lives in the URL,
 * and `navigation.svelte.ts` is its module singleton, imported directly by the
 * components that navigate. A note selection is not a fact about which
 * document is open, so routing it through this object bought a rename and
 * nothing else.
 *
 * The document choice lives here, visible once: account notes when this
 * generation has an account, device notes otherwise. The databases carry no
 * default, so this line is the whole of the policy, and a Local
 * Drafts feature would build a second object over `databases.device` in
 * the same way. A page lifetime is one auth generation (ADR-0232), so the
 * choice never changes while this object lives.
 *
 * One instance per mounted app generation, created by the layout's provider
 * and reached through `getHoneycrisp`, never a module-global singleton.
 * Nothing here needs disposing: the adapter's subscriptions are ref-counted
 * to the effects that read them, so they detach when the consuming
 * components unmount.
 */
export function createHoneycrisp({
	databases,
}: {
	databases: HoneycrispDatabases;
}) {
	const data = databases.account?.data ?? databases.device;
	const workspace = fromWorkspace(data);
	// Asymmetric on purpose: notes are table-local, folders are not. Deleting a
	// folder re-parents the notes that were in it, so it needs both tables and
	// says so by taking the workspace.
	const folders = createFolders(workspace);
	const notes = createNotes(workspace.tables.notes);

	/**
	 * The notes the user is currently looking at, in the order they appear.
	 *
	 * The one place the tables and the URL meet. Recently Deleted is its own
	 * list rather than a filter over the same one, because the folder and the
	 * query do not apply to it.
	 *
	 * Reading every note's prose is the cost of an active query, and it is paid
	 * only then: an empty query short-circuits before a body is ever touched,
	 * so typing inside a note never walks the vault. A note whose document has
	 * not arrived yet answers on its `preview`, which is what search could do
	 * before it could read prose at all.
	 */
	const visibleNotes = $derived.by(() => {
		if (navigation.isDeletedView) return notes.deleted.toSorted(byRecentEdit);

		const folderId = navigation.folderId;
		const q = navigation.query.trim().toLowerCase();
		return notes.all
			.filter((note) => folderId === null || note.folderId === folderId)
			.filter((note) => {
				if (!q) return true;
				if (note.title.toLowerCase().includes(q)) return true;
				return (notes.text(note.id) || note.preview).toLowerCase().includes(q);
			})
			.toSorted(byRecentEdit);
	});

	return {
		folders,
		notes,
		get visibleNotes() {
			return visibleNotes;
		},
		/**
		 * Create a note in the folder the user is looking at and open it in the
		 * editor. Lives here rather than on `notes` because it is the one command
		 * that spans the tables and the URL, and every create surface (⌘N, the
		 * list's + button, the palette) means exactly this composition.
		 */
		createNote(): void {
			navigation.selectNote(notes.create(navigation.folderId));
		},
		/**
		 * Storage pressure of the document this generation is showing,
		 * whichever that is. The one store verb the UI reads, exposed narrowly
		 * so the raw store plane stays behind this boundary.
		 */
		pressure: () => data.store.pressure(),
		/**
		 * The account's two capabilities, present exactly when this generation
		 * has one. Its data is not here, because it already is: `notes` and
		 * `folders` above are the chosen document.
		 */
		account:
			databases.account === undefined
				? undefined
				: {
						syncStatus: databases.account.syncStatus,
						rebuild: databases.account.rebuild,
					},
	};
}

export type Honeycrisp = ReturnType<typeof createHoneycrisp>;

export const [getHoneycrisp, setHoneycrisp] = createContext<Honeycrisp>();

// ─────────────────────────────────────────────────────────────────────────────
// The pieces the application above is made of. Nothing below is exported: they
// are one caller each, and reading them is optional until you need the detail.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An update landed, or the row was already gone, which is not news.
 *
 * Honeycrisp reports no write failures at all, and that is a claim about what
 * can actually go wrong rather than a shrug. An update is refused three ways.
 * `UnknownField` is a compile error before it is a runtime one. `Nonconforming`
 * needs a value that fails its declared arktype, and every value this file
 * writes is statically that type: a `boolean` into `'boolean'`, an
 * `InstantString.now()` into `'string.date.iso'`. That leaves `RowAbsent`,
 * which means another device deleted the row between the render and the click.
 *
 * That last one is ordinary, and this app already ruled on it twice:
 * `permanentlyDelete` calls an absent row "a no-op fact, not an error", and
 * `togglePin` returns early on one. The reactive list is about to drop the row
 * on its own, so a sentence would only ask the person to care about a race they
 * cannot lose. Silence is the honest answer, and it is what deleted the toast
 * wrapper every call site used to carry.
 *
 * The other two mean a declaration and this file disagree. That is ours, not
 * theirs, so it throws: uncaught, into the console, with a stack. The wrapper
 * this replaces caught around the whole call rather than the write, so a
 * `TypeError` in domain code and the `StoreUnusableError` a disposed store
 * throws both surfaced as "Could not update note". The second is especially
 * wrong: a disposed store means this generation is over, and the answer is a
 * reload rather than a retry.
 */
function updated(error: UpdateRowError | null): void {
	if (error === null || error.name === 'RowAbsent') return;
	throw error;
}

/**
 * The one order notes appear in: newest edit first.
 *
 * There is no user-selectable sort by decision; the earlier sort control was
 * inert (the list re-sorted by `updatedAt` regardless) and nobody noticed, so
 * the feature was deleted rather than repaired. This is ordering's single
 * owner: the list component groups (pinned, date labels) without ever
 * re-sorting.
 */
function byRecentEdit(
	a: { updatedAt: string },
	b: { updatedAt: string },
): number {
	return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * Honeycrisp's own folder concepts, over the reactive `folders` table.
 *
 * Same shape as `createNotes` and for the same reason: the reactive table
 * answers the "what rows are here" question, so what remains is domain: the
 * new-folder defaults, renaming, and the delete that re-parents notes and
 * cleans up the URL.
 */
function createFolders(workspace: ReactiveWorkspace<HoneycrispData>) {
	const table = workspace.tables.folders;

	// Name order, and nothing durable about order at all: it is deterministic
	// on every device without a schema field, and every surface that lists
	// folders (sidebar, move-to menu, palette) wants the same answer.
	const all = $derived(
		table.rows.toSorted((a, b) => a.name.localeCompare(b.name)),
	);

	return {
		get(id: FolderId) {
			return table.rows.find((folder) => folder.id === id);
		},
		get all() {
			return all;
		},

		// Nothing is returned because nothing wants it: all three create surfaces
		// make a folder and leave the person where they are. A note is different,
		// and says so by handing back its id.
		create(): void {
			const { error } = table.create({ name: 'New Folder' });
			// A create has no `RowAbsent` arm to forgive: there is no row yet. So
			// every refusal it can make is the impossible kind, and it throws.
			if (error !== null) throw error;
		},

		rename(folderId: FolderId, name: string): void {
			const { error } = table.update(folderId, { name });
			updated(error);
		},

		delete(folderId: FolderId): void {
			// Re-parents this folder's notes and then removes it. Both tables
			// invalidate on their own, so nothing has to be told to re-read.
			deleteHoneycrispFolder(workspace, folderId);
			navigation.folderRemoved(folderId);
		},
	};
}

/**
 * Honeycrisp's own note concepts, over the reactive `notes` table.
 *
 * The table already answers "what rows are here right now" reactively
 * (`fromWorkspace`): a read inside `$derived` re-runs on any commit that
 * touched the table, local writes, prose typed into a note's document, and
 * bytes from another device alike (ADR-0221), and a read in an event handler
 * is fresh. What this adds is what the platform cannot know: which rows count
 * as deleted, per-folder counts, where a note's prose is, and the domain
 * commands (soft delete, pinning, re-parenting) with their URL cleanup.
 */
function createNotes(
	table: ReactiveWorkspace<HoneycrispData>['tables']['notes'],
) {
	const all = $derived(table.rows.filter((note) => note.deletedAt === null));
	const deleted = $derived(
		table.rows.filter((note) => note.deletedAt !== null),
	);
	const countsByFolder = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of all) {
			if (note.folderId)
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
		}
		return counts;
	});

	/** Merge fields into a note, silently if the note is gone ({@link updated}). */
	function update(noteId: NoteId, changes: Partial<Note>): void {
		const { error } = table.update(noteId, changes);
		updated(error);
	}

	return {
		/**
		 * This note's prose, live, for the editor to bind to.
		 *
		 * The root was allocated with the row (ADR-0215) and lives in the
		 * application's one document, so there is no lease to open and nothing to
		 * await; edits from every device reach it through the transport like any
		 * other change. `undefined` means this note is no longer here.
		 *
		 * Exposed as a verb so the raw `tables` never has to be. The editor pane
		 * wanted one call and was given the whole store shape to make it.
		 */
		body(id: NoteId) {
			return table.document(id)?.get(NOTE_BODY);
		},
		/**
		 * This note's prose as one flat string, for search.
		 *
		 * A read rather than an index: the text is a type in the application's own
		 * document, so there is nothing to open and nothing to warm, and reading
		 * through means a paragraph that arrived from another device is findable
		 * the moment it lands.
		 */
		text(id: NoteId): string {
			return readNoteText(table.document(id));
		},
		get all() {
			return all;
		},
		get deleted() {
			return deleted;
		},
		get countsByFolder() {
			return countsByFolder;
		},
		get nonconforming() {
			return table.nonconforming;
		},

		create(folderId: FolderId | null): NoteId {
			const now = InstantString.now();
			const { data, error } = table.create(
				{
					folderId,
					title: '',
					preview: '',
					pinned: false,
					createdAt: now,
					updatedAt: now,
				},
				// Named here, once, at the only moment there is exactly one creator.
				// Reaching for the root lazily would let two devices first-opening
				// one note each mint their own and lose one (ADR-0215).
				{ document: [NOTE_BODY] },
			);
			// No `RowAbsent` arm to forgive: there is no row yet, so every refusal a
			// create can make is the impossible kind.
			if (error !== null) throw error;
			return data.id;
		},

		softDelete(noteId: NoteId): void {
			update(noteId, { deletedAt: InstantString.now() });
			navigation.noteRemoved(noteId);
		},

		restore(noteId: NoteId): void {
			update(noteId, { deletedAt: null });
		},

		permanentlyDelete(noteId: NoteId): void {
			// Deleting an absent note is a no-op fact, not an error.
			table.delete(noteId);
			navigation.noteRemoved(noteId);
		},

		togglePin(noteId: NoteId): void {
			const note = table.rows.find((candidate) => candidate.id === noteId);
			if (!note) return;
			update(noteId, { pinned: !note.pinned });
		},

		moveToFolder(noteId: NoteId, folderId: FolderId | null): void {
			update(noteId, { folderId });
		},

		/**
		 * Record the row metadata the editor derived from a note's prose.
		 *
		 * Only the row: the prose itself is already durable in the document, which
		 * is where it merges per character (ADR-0207), so this write is the title,
		 * preview and word count the list renders, plus the edit time it sorts on.
		 */
		updateContent(
			noteId: NoteId,
			content: Pick<Note, 'title' | 'preview' | 'wordCount'>,
		): void {
			update(noteId, { ...content, updatedAt: InstantString.now() });
		},
	};
}
