/**
 * A live Vault: one directory of typed markdown Tables, read as one relational unit.
 *
 * This is the layer above {@link createTable}. A Table watches ONE folder's files; a Vault watches
 * the ROOT (`watch_vault`, depth-1) for its table set changing, and composes a `createTable` per
 * table the watcher resolves. `watch_vault` applies the same marker rule as the CLI loader
 * (`@epicenter/matter-core/fs` `loadPath`, ADR-0029/0032): a folder is a table XOR a container of tables. A marked
 * root IS the single table (its subfolders are ignored); an unmarked root is a container whose
 * immediate marked child folders are the tables. An unmarked folder is not data and is skipped, so
 * opening a marked leaf and opening a container of marked folders both work; depth is reached by
 * re-opening the deeper folder, never by loading two levels at once. The marker's contents type a
 * Table; its presence is what makes the folder a Table at all. It owns its Tables' lifetimes:
 * dispose the Vault and every Table watch and the root watch stop. The Vault declares nothing
 * itself: it is the live union of its Tables' self-declared contracts, discovered, not configured.
 *
 * Why this exists: references only have meaning across two Tables of the SAME Vault
 * (`adaptations.page -> pages`), so resolution is a Vault-level operation. The Vault holds every
 * Table together, runs `assess` over all of them at once, and exposes ONE live {@link
 * VaultIntegrity} that the grid, the Table switcher, and the integrity panel all select from. The
 * single open table case is just a degenerate Vault of one Table.
 *
 * The Vault also composes the vault's SQLite mirror ({@link createMirror}): one hidden
 * `<root>/.matter/matter.sqlite` holding one SQL table per folder, so an agent or SQL console can
 * JOIN across the whole vault (`FROM pages JOIN adaptations`). The Vault wires each Table's onChange
 * to `mirror.syncTable` and drops a table's slice when its folder leaves; the mirror owns the db
 * lifecycle itself. It is a PROJECTION only: `assess` owns every reference verdict; SQL never resolves
 * references.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam), mirroring {@link createTable}.
 */

import { assess, basename, type VaultIntegrity } from '@epicenter/matter-core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { createMirror } from './mirror.svelte';
import { createTable, type TableHandle } from './table.svelte';

/**
 * Open `root` as a live vault. Synchronous and IO-free: the table set starts empty and fills from
 * the first table list once the root watch is armed, so there is no separate initial listing and no
 * list-then-watch gap (the Rust side arms before its seed scan).
 */
export function createVault(root: string) {
	const folderName = basename(root);

	// The vault's SQLite projection, hidden at `<root>/.matter` (content folders stay pure markdown;
	// classification skips dot-dirs, so `.matter/` is never mistaken for a table, even in a one-table
	// vault where the root IS the folder). Rust owns the on-disk layout, so the Vault passes only the
	// root; the mirror owns its own db lifecycle (fresh on open, single-writer rebuilds).
	const mirror = createMirror(root);

	// table folder path -> its live Table. The table list from `watch_vault` reconciles this map;
	// the `tables` getter sorts by name so the switcher and integrity read a stable order
	// regardless of when a folder was added.
	const tables = new SvelteMap<string, TableHandle>();

	/**
	 * Reconcile the live tables against a fresh table list (the whole set `watch_vault` resolved:
	 * the root itself when marked, else its immediate marked child folders): dispose the folders
	 * that left, compose the folders that arrived, leave the rest untouched so an unrelated change
	 * (a loose file written at the root) churns nothing.
	 */
	function reconcile(paths: string[]): void {
		// A snapshot can still arrive after dispose (the seed, or a debounced batch already in flight
		// when the vault closed): ignore it, or it would arm a fresh per-folder watch with nothing left
		// to dispose it. Mirrors the same `disposed` guard the watch-id path below already honors.
		if (disposed) return;
		const incoming = new Set(paths);
		for (const [path, table] of tables) {
			if (incoming.has(path)) continue;
			table.dispose();
			tables.delete(path);
			mirror.dropTable(table.folderName); // the folder left: its SQL table must not linger in the shared db
		}
		for (const path of paths) {
			if (!tables.has(path)) {
				// Each applied watcher batch syncs this table's slice into the mirror. The lookup guards
				// a late batch that fires after the table was disposed (then there is nothing to sync).
				tables.set(
					path,
					createTable(path, () => {
						const table = tables.get(path);
						if (table) mirror.syncTable(table.folderName, table.read);
					}),
				);
			}
		}
	}

	/** The vault's tables, sorted by folder name: the stable order every surface renders in. */
	const orderedTables = $derived(
		[...tables.values()].sort((a, b) =>
			a.folderName.localeCompare(b.folderName),
		),
	);

	/**
	 * The one composed integrity model, recomputed whenever any table's read changes or the table
	 * set changes. Every readable table contributes itself (folder name + classified read) to
	 * `assess`, which resolves references across them; an unreadable folder never reaches here (the
	 * root watch only lists folders it could stat as directories). The grid, the switcher's
	 * per-table badges, and the integrity sheet are all pure selectors over this.
	 */
	const integrity = $derived.by(
		(): VaultIntegrity =>
			assess(
				orderedTables.map((table) => ({
					name: table.folderName,
					status: 'readable' as const,
					read: table.read,
				})),
			),
	);

	// Opening a vault IS observing it: arm the root watch now. `watch_vault` seeds the current
	// membership, then streams a snapshot per change, all through `reconcile`. `whenReady` resolves
	// once the watch is armed (the seed scan finished before the invoke resolved) and rejects if it
	// could not be armed; the shell gates on it with `{#await}`.
	const channel = new Channel<string[]>();
	channel.onmessage = reconcile;
	let watchId: number | undefined;
	let disposed = false;
	const whenReady = invoke<number>('watch_vault', { path: root, channel }).then(
		(id) => {
			if (disposed) void invoke('unwatch_vault', { id });
			else watchId = id;
		},
	);

	/** Stop the root watch AND every composed table watch. The keyed route component calls this on teardown. */
	function dispose(): void {
		disposed = true;
		if (watchId !== undefined) void invoke('unwatch_vault', { id: watchId });
		for (const table of tables.values()) table.dispose();
		tables.clear();
	}

	/**
	 * Adopt the root folder as a table by writing the canonical untyped marker
	 * (`matter.json` = `{}`) into it (ADR-0029). A folder is a table iff it has a marker, so an
	 * unmarked root shows no tables until adopted. Writing the marker at the root is a top-level
	 * change the non-recursive root watch already sees, so it re-scans and surfaces the now-marked
	 * root as a table live: there is nothing to reconcile here. The empty state calls this.
	 */
	async function adopt(): Promise<void> {
		await invoke('write_entry', {
			path: root,
			fileName: 'matter.json',
			content: '{}',
		});
	}

	return {
		folderName,
		root,
		whenReady,
		dispose,
		adopt,
		/** The vault's SQLite projection. The active pane's WHERE filter queries it; the filter's freshness
		 *  signal (`mirror.version`) and query seam live here, not on the vault. */
		mirror,
		/** The vault's live tables, sorted by folder name. A pure read with no side effects. */
		get tables(): TableHandle[] {
			return orderedTables;
		},
		/** The one composed integrity model across every table. Read it reactively. */
		get integrity(): VaultIntegrity {
			return integrity;
		},
	};
}

export type VaultHandle = ReturnType<typeof createVault>;
