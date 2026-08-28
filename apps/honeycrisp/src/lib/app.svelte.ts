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
import { fromData, type ReactiveData } from '@epicenter/svelte';
import { createContext } from 'svelte';
import { navigation } from './navigation.svelte.js';

/**
 * The reactive Honeycrisp application, for one mounted app generation.
 *
 * The opened database is a route's yield: one document, optional attached
 * sync, and the disposal that closes it (ADR-0233). This is the application
 * built on top of that one document, and the one object the UI consumes. It
 * owns the reactive named tables over that document (`fromData`),
 * Honeycrisp's domain operations (`notes`, `folders`), the one derivation that
 * needs both those tables and where the user is (`visibleNotes`), and the
 * narrow account and store capabilities the UI actually needs.
 *
 * The tables themselves do not cross this boundary either. `notes` and
 * `folders` are the whole vocabulary a component gets, so nothing downstream
 * can reach a raw write verb, the `kv` root, or the other table. That was not
 * true until recently: `tables` was exposed so one editor pane could reach one
 * note's prose, and it now asks for that by name (`notes.openBody`).
 *
 * Where the user is looking is deliberately NOT here. That lives in the URL,
 * and `navigation.svelte.ts` is its module singleton, imported directly by the
 * components that navigate. A note selection is not a fact about which
 * document is open, so routing it through this object bought a rename and
 * nothing else.
 *
 * The route chooses the document before this function is called. There is no
 * fallback and no account/local decision below this boundary.
 *
 * One instance per mounted route generation, created by the route's provider
 * and reached through `getHoneycrisp`, never a module-global singleton.
 * Nothing here needs disposing: the adapter's subscriptions are ref-counted
 * to the effects that read them, so they detach when the consuming
 * components unmount.
 */
export function createHoneycrisp({ data }: { data: HoneycrispData }) {
	const reactiveData = fromData(data);
	// Asymmetric on purpose: notes are table-local, folders are not. Deleting a
	// folder re-parents the notes that were in it, so it needs both tables and
	// says so by taking the database.
	const folders = createFolders(reactiveData);
	const notes = createNotes(reactiveData.tables.notes);

	/**
	 * The notes the user is currently looking at, in the order they appear.
	 *
	 * The one place the tables and the URL meet. Recently Deleted is its own
	 * list rather than a filter over the same one, because the folder and the
	 * query do not apply to it.
	 *
	 * Search covers the row: the title and the preview, both scalar fields the
	 * editor writes back on every content change. Prose lives in each note's
	 * own document, loaded only when the note is opened (ADR-0248), so a query
	 * never hydrates the vault; what it can find past the preview's hundred
	 * characters is the cost of that laziness.
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
				return note.preview.toLowerCase().includes(q);
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
 * needs a value that fails its declared field descriptor, and every value this file
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
 * Same job as `createNotes`: the reactive table answers "what rows are here",
 * so what remains is domain, which here is the new-folder defaults, renaming,
 * and the delete that re-parents notes and cleans up the URL.
 *
 * It takes the whole database where `createNotes` takes one table, and that
 * difference is the point rather than an oversight: deleting a folder has to
 * reach the notes in it.
 */
function createFolders(data: ReactiveData<HoneycrispData>) {
	const table = data.tables.folders;

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
			table.create({ name: 'New Folder', icon: null });
		},

		rename(folderId: FolderId, name: string): void {
			const { error } = table.update(folderId, { name });
			updated(error);
		},

		/**
		 * Set this folder's emoji, or clear it with `null`.
		 *
		 * One native emoji string, stored as-is. Not a shortcode and not an icon
		 * name: the row has to carry a value that renders on every device without
		 * this release agreeing with the next one about a lookup table, and an
		 * emoji is already that. It is also why the field is `string|null` rather
		 * than an enum of the icons this version happens to ship.
		 */
		setIcon(folderId: FolderId, icon: string | null): void {
			const { error } = table.update(folderId, { icon });
			updated(error);
		},

		delete(folderId: FolderId): void {
			// Re-parents this folder's notes and then removes it. Both tables
			// invalidate on their own, so nothing has to be told to re-read.
			deleteHoneycrispFolder(data, folderId);
			navigation.folderRemoved(folderId);
		},
	};
}

/**
 * Honeycrisp's own note concepts, over the reactive `notes` table.
 *
 * The table already answers "what rows are here right now" reactively
 * (`fromData`): a read inside `$derived` re-runs on any commit that
 * touched the table, local writes, prose typed into a note's document, and
 * bytes from another device alike (ADR-0221), and a read in an event handler
 * is fresh. What this adds is what the platform cannot know: which rows count
 * as deleted, per-folder counts, where a note's prose is, and the domain
 * commands (soft delete, pinning, re-parenting) with their URL cleanup.
 */
function createNotes(table: ReactiveData<HoneycrispData>['tables']['notes']) {
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

	/**
	 * Open this note's prose for the editor to bind to.
	 *
	 * A load, awaited: the note's document is independent and hydrates on
	 * demand (ADR-0248), and the handle that comes back is complete rather
	 * than half-hydrated, so the editor never merges keystrokes into a
	 * document that is still arriving. `undefined` means this note is no
	 * longer here. The caller closes what it opened; the pane holds exactly
	 * one note open at a time.
	 *
	 * The only place `NOTE_BODY` is read: one spelling of the root name.
	 */
	async function openBody(id: NoteId) {
		const { data: handle, error } = await table.openDocument(id);
		// Storage that cannot be read is this generation's boot-shaped failure,
		// not a per-note outcome; it surfaces at the app's error boundary.
		if (error !== null) throw error;
		if (handle === undefined) return undefined;
		return {
			body: handle.get(NOTE_BODY),
			close: () => handle[Symbol.dispose](),
		};
	}

	return {
		/**
		 * Exposed as a verb so the raw `tables` never has to be. The editor pane
		 * wanted this one call and was given the whole store shape to make it.
		 */
		openBody,
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
			const row = table.create({
				folderId,
				title: '',
				preview: '',
				pinned: false,
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
			});
			return row.id;
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
	};
}
