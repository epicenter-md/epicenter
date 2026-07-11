/**
 * A live Table: one folder on disk, read as one typed table.
 *
 * The folder is the truth and other processes write it (agents, your editor, git),
 * so the table is not a one-shot read: a single `watch_folder` command arms a
 * native folder watcher (backed by `notify`), pushes the folder's current
 * contents as a first batch, then streams a batch per debounced change. Each
 * pushed delta is self-contained ({@link FileDelta}: a file name plus the file's
 * observable state), so the JS never round-trips a separate read. External
 * updates, the seed scan, AND the app's own successful writes all flow through
 * ONE path (`applyDeltas`) into ONE `SvelteMap`.
 *
 * Lifecycle: opening a table IS observing it, so the watcher starts at
 * construction. `whenReady` resolves once it is armed (the seed scan has run, so
 * the store holds the folder's current contents) and rejects if it cannot be, which
 * the UI gates on with `{#await}`. `dispose()` stops the OS watch. The keyed route
 * component (`/vault/[id]`) owns one table's lifetime, constructing it on mount and
 * disposing it on destroy, so no module singleton or standing effect drives the
 * watcher; the set of open vaults is just a persisted list (`open-vaults.svelte.ts`).
 * A Vault that composes many tables (one per child folder) is the next layer up;
 * see the vault-as-relational-unit spec.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam). Develop with
 * `bun run tauri dev`.
 */

import {
	basename,
	buildView,
	editBody,
	editField,
	loadContract,
	MatterReadError,
	parseEntry,
	type Row,
	type TableRead,
	type UnreadableFile,
} from '@epicenter/matter-core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
// One file's observable state, pushed by `watch_folder` (content / removed /
// unreadable). Generated from the Rust `FileDelta` enum by ts-rs, so the IPC payload
// has one source of truth; regenerate with `cargo test` in `src-tauri`.
import type { FileDelta } from './bindings/FileDelta';

/**
 * Open `path` as a live table. Synchronous and IO-free: the store starts empty
 * and fills from the first pushed batch once `watch()` runs, so there is no
 * separate initial read and no read-then-watch gap.
 *
 * `onChange` is invoked at the end of each applied watcher batch — the Vault
 * passes an adapter that projects this one table into the shared `.matter`
 * mirror. The Table owns no SQLite itself; the callback keeps the rebuild trigger
 * imperative and at its source (the batch), not laundered through a reactive effect.
 */
export function createTable(path: string, onChange: () => void) {
	const folderName = basename(path);

	// ONE store, keyed by filename: each entry is a `Result` that is either a
	// parsed row or the error that stopped it. `set` replaces, so "a name is
	// readable XOR unreadable" is structural, not an invariant kept by hand across
	// two maps.
	const files = new SvelteMap<string, Result<Row, UnreadableFile['error']>>();
	let contractText = $state<string | undefined>(undefined);
	// Set when the LAST save could not reach disk. A save never mutates the store
	// (that is the watcher's job); this is the only state a write touches.
	let writeError = $state<string | undefined>(undefined);
	// Memoized: Schema.Compile runs only when matter.json changes, not on every
	// .md change. A single-file change reclassifies against these cached columns.
	const loaded = $derived(loadContract(contractText));

	/** Apply one pushed batch to the store (the seed and every update). */
	function applyDeltas(deltas: FileDelta[]) {
		for (const delta of deltas) {
			if (delta.fileName === 'matter.json') {
				// A removed or unreadable matter.json is no contract: degrade to the raw view.
				contractText = delta.kind === 'content' ? delta.text : undefined;
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
		// One signal per applied batch: the Vault's adapter projects this table into the
		// shared `.matter` mirror (off the UI task; the grid is already current from the map
		// mutations above). Per-batch, not debounced: the native watcher already coalesces a
		// burst into one batch. The Table itself touches no SQLite.
		onChange();
	}

	/**
	 * The current classified folder, derived from the files map + the loaded contract.
	 * The ONE place "files map -> TableRead" lives, MEMOIZED so the `read` getter (the UI
	 * surface) and the Vault's mirror adapter (which reads `read` in its deferred rebuild)
	 * share a single classification instead of each recomputing it. Recomputes only when
	 * `files` or the loaded contract changes.
	 */
	const read = $derived.by((): TableRead => {
		const rows: TableRead['rows'] = [];
		const unreadable: TableRead['unreadable'] = [];
		for (const [fileName, { data, error }] of files) {
			if (error) unreadable.push({ fileName, error });
			else rows.push(data);
		}
		return { rows, unreadable, view: buildView(rows, loaded) };
	});

	/**
	 * Serialize writes to one file. A folder edit is read-modify-write (read the
	 * freshest bytes, transform, atomic-write), so two writes to the SAME file must
	 * run in order or the second reads stale bytes and drops the first's change.
	 * Different files still write in parallel; the per-file chain is pruned when it
	 * drains, so the map does not grow with the folder.
	 */
	const writeTails = new Map<string, Promise<void>>();
	function serializeWrite(
		fileName: string,
		run: () => Promise<void>,
	): Promise<void> {
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
	function write(
		fileName: string,
		edit: (raw: string) => string,
	): Promise<void> {
		return serializeWrite(fileName, async () => {
			const { data: next, error: failure } = await tryAsync({
				try: async () => {
					const raw = await invoke<string | null>('read_entry', {
						path,
						fileName,
					});
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
	function saveField(
		fileName: string,
		key: string,
		value: unknown,
	): Promise<void> {
		return write(fileName, (raw) => editField(raw, key, value));
	}

	/** Replace a file's body, keeping its frontmatter values intact. */
	function saveBody(fileName: string, body: string): Promise<void> {
		return write(fileName, (raw) => editBody(raw, body));
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
	const whenReady = invoke<number>('watch_folder', { path, channel }).then(
		(id) => {
			// Disposed before the id arrived: drop the watcher that just resolved.
			if (disposed) void invoke('unwatch_folder', { id });
			else watchId = id;
		},
	);
	/** Stop the OS watch. The keyed route component calls this when it is torn down (a table switch or vault close). */
	function dispose(): void {
		disposed = true;
		if (watchId !== undefined) void invoke('unwatch_folder', { id: watchId });
	}

	return {
		folderName,
		path,
		saveField,
		saveBody,
		dispose,
		/** Resolves once the OS watcher is armed (the folder is being observed), with the
		 *  seed contents already applied; rejects if it could not be armed. */
		whenReady,
		/** The current classified folder. A pure read with no side effects. */
		get read(): TableRead {
			return read;
		},
		/** Set if the most recent save could not reach disk. */
		get writeError(): string | undefined {
			return writeError;
		},
	};
}

export type TableHandle = ReturnType<typeof createTable>;

/**
 * The slice of a {@link TableHandle} the grid renders from: the folder name, the
 * classified read, and the two save commands. This is the narrow dependency boundary
 * `TableGrid` depends on, NOT the full table handle, so the grid cannot reach the
 * watcher lifecycle (`whenReady` / `dispose` / `path`) it has no business touching,
 * and a `Pick` of the live handle satisfies it for free.
 */
export type TableView = Pick<
	TableHandle,
	'folderName' | 'read' | 'saveField' | 'saveBody'
>;
