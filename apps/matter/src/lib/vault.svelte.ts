/**
 * A live view over a folder on disk.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the vault is not a one-shot read: a single `watch_folder` command arms a
 * native folder watcher (backed by `notify`), pushes the folder's current
 * contents as a first batch, then streams a batch per debounced change. Each
 * pushed delta is self-contained ({@link FileDelta}: a file name plus the file's
 * observable state), so the JS never round-trips a separate read. External
 * updates, the seed scan, AND the app's own successful writes all flow through
 * ONE path (`applyDeltas`) into ONE `SvelteMap`.
 *
 * Lifecycle: opening a vault IS observing it, so the watcher starts at
 * construction. `whenReady` resolves once it is armed (the seed scan has run, so
 * the store holds the folder's current contents) and rejects if it cannot be, which
 * the UI gates on with `{#await}`. `dispose()` stops the OS watch. The keyed route
 * component (`/vault/[id]`) owns one vault's lifetime, constructing it on mount and
 * disposing it on destroy, so no module singleton or standing effect drives the
 * watcher; the set of open vaults is just a persisted list (`open-vaults.svelte.ts`).
 *
 * Desktop-only: it talks to Tauri directly (no platform seam). Develop with
 * `bun run tauri dev`.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
import { editBody, editField } from './core/serialize';
import { MIRROR_TABLE, projectToSqlite, quoteIdent } from './core/sqlite';
import {
	buildView,
	type FolderRead,
	loadModel,
	MatterReadError,
	type UnreadableFile,
} from './core/folder';
import { parseEntry, type Row } from './core/parse';
// One file's observable state, pushed by `watch_folder` (content / removed /
// unreadable). Generated from the Rust `FileDelta` enum by ts-rs, so the IPC payload
// has one source of truth; regenerate with `cargo test` in `src-tauri`.
import type { FileDelta } from './bindings/FileDelta';

/** The vault's own folder name (its basename). Per-file paths are Rust's. */
const basename = (path: string) => path.split(/[/\\]/).pop() ?? path;

/**
 * Open `path` as a live vault. Synchronous and IO-free: the store starts empty
 * and fills from the first pushed batch once `watch()` runs, so there is no
 * separate initial read and no read-then-watch gap.
 */
export function createVault(path: string) {
	const folderName = basename(path);

	// ONE store, keyed by filename: each entry is a `Result` that is either a
	// parsed row or the error that stopped it. `set` replaces, so "a name is
	// readable XOR unreadable" is structural, not an invariant kept by hand across
	// two maps.
	const files = new SvelteMap<string, Result<Row, UnreadableFile['error']>>();
	let modelText = $state<string | undefined>(undefined);
	// Set when the LAST save could not reach disk. A save never mutates the store
	// (that is the watcher's job); this is the only state a write touches.
	let writeError = $state<string | undefined>(undefined);
	// Bumped after each successful `matter.sqlite` rebuild, so a reader can key its query on
	// the mirror being fresh rather than on the in-memory rows (which lead the file by the
	// async rebuild). The WHERE filter reacts to this; see `reconcileMirror`.
	let mirrorVersion = $state(0);
	// Memoized: Schema.Compile runs only when matter.json changes, not on every
	// .md change. A single-file change reclassifies against these cached columns.
	const loaded = $derived(loadModel(modelText));

	/** Apply one pushed batch to the store (the seed and every update). */
	function applyDeltas(deltas: FileDelta[]) {
		for (const delta of deltas) {
			if (delta.fileName === 'matter.json') {
				// A removed or unreadable model is no model: degrade to the raw view.
				modelText = delta.kind === 'content' ? delta.text : undefined;
				continue;
			}
			switch (delta.kind) {
				case 'content':
					files.set(delta.fileName, parseEntry(delta.fileName, delta.text));
					break;
				case 'removed':
					files.delete(delta.fileName);
					break;
				case 'unreadable':
					// `Undecodable()` already returns an `Err`, so it stores directly as
					// the file's failed `Result` (no row, the read-level error).
					files.set(delta.fileName, MatterReadError.Undecodable());
					break;
			}
		}
		// Rebuild the read-only SQLite mirror once per batch, off the UI task: the grid is
		// already current from the map mutations above, so defer the (potentially large)
		// projection with setTimeout so it never delays paint. Per-batch, not debounced:
		// the native watcher already coalesces a burst into one batch, and a rebuild that
		// lands after teardown just writes that folder's own final truth.
		setTimeout(reconcileMirror, 0);
	}

	/**
	 * The current classified folder, derived from the files map + the loaded model.
	 * The ONE place "files map -> FolderRead" lives, MEMOIZED so the `read` getter (the
	 * UI surface) and `reconcileMirror` (the SQLite mirror) share a single classification
	 * instead of each recomputing it. Recomputes only when `files` or the loaded model
	 * changes; `reconcileMirror` reads it when its deferred rebuild runs, so it sees the
	 * latest classification rather than a stale snapshot.
	 */
	const read = $derived.by((): FolderRead => {
		const rows: FolderRead['rows'] = [];
		const unreadable: FolderRead['unreadable'] = [];
		for (const [fileName, { data, error }] of files) {
			if (error) unreadable.push({ fileName, error });
			else rows.push(data);
		}
		return { rows, unreadable, view: buildView(rows, loaded) };
	});

	/**
	 * Reconcile `<path>/matter.sqlite` from the current readable rows (valid AND drafts
	 * in progress): a FULL DROP + CREATE + INSERT, so the file is a pure function of the
	 * folder (self-healing, no incremental drift to debug, no stale row an agent could
	 * read). The SvelteMap stays the live in-app surface; this file is the EXTERNAL one.
	 * An unmodeled folder has no typed table, so it is skipped. Fire-and-forget: a failure never blocks the
	 * grid and self-heals on the next batch (the rebuild is a full DROP + CREATE + INSERT),
	 * so a transient error needs no surfacing. The JS projector builds all the SQL; the
	 * Rust `write_mirror` command only executes it and binds the rows.
	 *
	 * A full rebuild (not an incremental sync) is deliberate: benchmarks keep it well
	 * under a frame to ~50k rows, it runs off the UI task (scheduled with setTimeout from
	 * `applyDeltas`), and for an agent read surface "pure function of truth" is a safety
	 * property, not just simplicity.
	 */
	function reconcileMirror(): void {
		const { view } = read;
		if (view.mode !== 'modeled') return;
		const { schema, insert, rows: tuples } = projectToSqlite(
			view.model,
			view.conformance,
		);
		void invoke('write_mirror', { path, schema, insert, rows: tuples })
			.then(() => {
				mirrorVersion++; // the file is now fresh: wake any reader keyed on the mirror
			})
			.catch(() => {});
	}

	/**
	 * Serialize writes to one file. A folder edit is read-modify-write (read the
	 * freshest bytes, transform, atomic-write), so two writes to the SAME file must
	 * run in order or the second reads stale bytes and drops the first's change.
	 * Different files still write in parallel; the per-file chain is pruned when it
	 * drains, so the map does not grow with the folder.
	 */
	const writeTails = new Map<string, Promise<void>>();
	function serializeWrite(fileName: string, run: () => Promise<void>): Promise<void> {
		const tail = (writeTails.get(fileName) ?? Promise.resolve()).then(run);
		const settled = tail.catch(() => {});
		writeTails.set(fileName, settled);
		void settled.then(() => {
			if (writeTails.get(fileName) === settled) writeTails.delete(fileName);
		});
		return tail;
	}

	/**
	 * Apply one edit to a file on disk: read the freshest bytes, transform them in
	 * JS, write atomically, then feed the result straight back through `applyDeltas`.
	 * A command in the CQRS sense: it writes the file (the truth) and applies ITS OWN
	 * result on success, rather than waiting ~300ms for the change to echo back
	 * through the watcher. The watcher's later echo re-applies identical bytes
	 * (harmless), and EXTERNAL edits still arrive only through it, so the map equals
	 * disk after every settled write without sitting on a round-trip.
	 *
	 * Reading at write time (rather than caching raw text in the store) keeps the
	 * edit faithful to the current bytes and keeps the store a parsed read-model with
	 * no second copy to drift. A failed write leaves the map untouched (we apply only
	 * on success) and surfaces in `writeError`.
	 */
	function write(fileName: string, edit: (raw: string) => string): Promise<void> {
		return serializeWrite(fileName, async () => {
			const { data: next, error: failure } = await tryAsync({
				try: async () => {
					const raw = await invoke<string | null>('read_entry', { path, fileName });
					const text = edit(raw ?? '');
					await invoke('write_entry', { path, fileName, content: text });
					return text;
				},
				catch: (cause) => Err({ message: extractErrorMessage(cause) }),
			});
			if (failure) {
				writeError = failure.message;
				return;
			}
			writeError = undefined;
			applyDeltas([{ kind: 'content', fileName, text: next }]);
		});
	}

	/**
	 * Set or clear one frontmatter field (`value === undefined` clears it). The
	 * transform ({@link editField}) is applied to the FRESH bytes on disk, not the
	 * in-memory projection, so a concurrent external edit to another field is read,
	 * not clobbered. Writes to one file are serialized, so two quick edits cannot
	 * interleave their read-modify-write and drop one of the changes.
	 */
	function saveField(fileName: string, key: string, value: unknown): Promise<void> {
		return write(fileName, (raw) => editField(raw, key, value));
	}

	/** Replace a file's body, keeping its frontmatter values intact. */
	function saveBody(fileName: string, body: string): Promise<void> {
		return write(fileName, (raw) => editBody(raw, body));
	}

	/**
	 * Filter the folder with a SQL WHERE clause: run it against the mirror
	 * (`matter.sqlite`, read-only) and return the FILE NAMES of the matching rows, so the
	 * grid can narrow its live rows by a SQL predicate while still rendering them with the
	 * rich, editable widgets. Every readable row is in the mirror (drafts included), with
	 * a missing cell as NULL, so a clause like `format = 'carousel'` finds an in-progress
	 * draft too; only unparseable files (which never became a row) are absent. The clause
	 * is interpolated raw, it is the user's own query on their own local file and the
	 * connection is read-only, so the worst a bad clause does is return an error.
	 */
	function matchingFileNames(
		where: string,
	): Promise<Result<Set<string>, { message: string }>> {
		const sql = `SELECT "file" FROM ${quoteIdent(MIRROR_TABLE)} WHERE ${where}`;
		return tryAsync({
			try: async () => {
				// No limit: a name-only filter returns every matching row, never a silent cap.
				const { rows } = await invoke<{ columns: string[]; rows: unknown[][] }>(
					'query_mirror',
					{ path, sql, limit: null },
				);
				return new Set(rows.map((row) => String(row[0])));
			},
			catch: (cause) => Err({ message: extractErrorMessage(cause) }),
		});
	}

	// Opening a vault IS observing it: arm the OS watcher now. `watch_folder` seeds the store
	// with the folder's current contents, then streams a batch per change, all through
	// `applyDeltas`. `whenReady` resolves once the watch is armed (the seed scan finishes
	// before `watch_folder` resolves, so even an empty folder resolves rather than hanging)
	// and rejects if it cannot be armed; the UI gates on it with `{#await}`.
	const channel = new Channel<FileDelta[]>();
	channel.onmessage = applyDeltas;
	let watchId: number | undefined;
	let disposed = false;
	const whenReady = invoke<number>('watch_folder', { path, channel }).then((id) => {
		// Disposed before the id arrived: drop the watcher that just resolved.
		if (disposed) void invoke('unwatch_folder', { id });
		else watchId = id;
	});
	/** Stop the OS watch. The keyed route component calls this when it is torn down (a tab switch or close). */
	function dispose(): void {
		disposed = true;
		if (watchId !== undefined) void invoke('unwatch_folder', { id: watchId });
	}

	return {
		folderName,
		path,
		saveField,
		saveBody,
		matchingFileNames,
		dispose,
		/** Resolves once the OS watcher is armed (the folder is being observed), with the
		 *  seed contents already applied; rejects if it could not be armed. */
		whenReady,
		/** The current classified folder. A pure read with no side effects. */
		get read(): FolderRead {
			return read;
		},
		/** Set if the most recent save could not reach disk. */
		get writeError(): string | undefined {
			return writeError;
		},
		/** Increments after each successful `matter.sqlite` rebuild. Read it (reactively) to
		 *  re-run only once the mirror is fresh, rather than the moment the in-memory rows change. */
		get mirrorVersion(): number {
			return mirrorVersion;
		},
	};
}

export type Vault = ReturnType<typeof createVault>;

/**
 * The slice of a {@link Vault} the grid renders from: the folder name, the
 * classified read, and the two save commands. This is the dependency boundary
 * `FolderGrid` depends on, NOT the full vault, so anything that can produce a
 * classified folder and accept edits can drive the grid. The live vault satisfies
 * it for free (it is a `Pick` of it); the demo vault satisfies it WITHOUT faking
 * the disk lifecycle (`whenReady` / `dispose` / `path`), so the demo is an honest
 * drop-in rather than a vault pretending to watch a folder.
 */
export type FolderGridVault = Pick<Vault, 'folderName' | 'read' | 'saveField' | 'saveBody'>;
