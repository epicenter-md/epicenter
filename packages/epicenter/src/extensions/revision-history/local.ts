import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import type { ExtensionContext } from '../../dynamic/extension';
import type { KvField, TableDefinition } from '../../dynamic/schema';

const SNAPSHOT_EXTENSION = '.ysnap';
const METADATA_EXTENSION = '.json';

/**
 * Snapshot metadata stored in sidecar .json files.
 */
type SnapshotMetadata = {
	description?: string;
};

/**
 * Version entry metadata.
 */
export type VersionEntry = {
	/** Unix timestamp in milliseconds. */
	timestamp: number;
	/** Optional description (e.g., "Before major edit"). */
	description?: string;
	/** File size in bytes. */
	size: number;
	/** Filename (e.g., "1704067200000.ysnap"). */
	filename: string;
};

/**
 * Configuration for the local revision history extension.
 */
export type LocalRevisionHistoryConfig = {
	/**
	 * Base directory for workspace storage.
	 *
	 * Snapshots are saved to `{directory}/{workspaceId}/snapshots/`.
	 */
	directory: string;

	/**
	 * Debounce interval in milliseconds for auto-saving on Y.Doc changes.
	 * Default: 1000ms.
	 */
	debounceMs?: number;

	/**
	 * Maximum number of versions to keep.
	 * Oldest versions are deleted when exceeded.
	 * Default: undefined (no limit).
	 */
	maxVersions?: number;
};

/**
 * Local revision history extension using the filesystem.
 *
 * Stores Y.Snapshots as binary files for time-travel and revision history.
 * Files are named by timestamp for automatic sorting. Automatically saves
 * snapshots on Y.Doc changes with configurable debouncing.
 *
 * **CRITICAL**: Requires `gc: false` on the Y.Doc for snapshots to work.
 * The extension will throw if garbage collection is enabled.
 *
 * **Platform**: Node.js/Desktop (Tauri, Electron, Bun)
 *
 * **Storage**: `{directory}/{workspaceId}/snapshots/{timestamp}.ysnap`
 *
 * @example Basic usage
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/dynamic';
 * import { localRevisionHistory } from '@epicenter/hq/extensions/revision-history';
 *
 * const workspace = createWorkspace(definition).withExtensions({
 *   persistence,
 *   revisions: (ctx) => localRevisionHistory(ctx, {
 *     directory: './workspaces',
 *     maxVersions: 50,
 *   }),
 * });
 *
 * // Save a version manually (bypasses debounce)
 * workspace.extensions.revisions.save('Before refactor');
 *
 * // List all versions
 * const versions = await workspace.extensions.revisions.list();
 *
 * // View a historical version (read-only)
 * const oldDoc = await workspace.extensions.revisions.view(5);
 * console.log(oldDoc.getText('content').toString());
 *
 * // Restore to a version (copies data to current doc)
 * await workspace.extensions.revisions.restore(5);
 * ```
 *
 * @example Custom debounce interval
 * ```typescript
 * const workspace = createWorkspace(definition).withExtensions({
 *   revisions: (ctx) => localRevisionHistory(ctx, {
 *     directory: './workspaces',
 *     debounceMs: 5000,  // Save 5 seconds after last change
 *   }),
 * });
 * ```
 *
 * @example Google Docs-style slider UI
 * ```typescript
 * const versions = await workspace.extensions.revisions.list();
 *
 * // Scrub through versions
 * async function onSliderChange(index: number) {
 *   const previewDoc = await workspace.extensions.revisions.view(index);
 *   // Render previewDoc in read-only mode
 * }
 *
 * // Restore when user clicks "Restore"
 * async function onRestore(index: number) {
 *   await workspace.extensions.revisions.restore(index);
 * }
 * ```
 */
export async function localRevisionHistory<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(
	{ ydoc, id }: ExtensionContext<TTableDefinitions, TKvFields>,
	{ directory, debounceMs = 1000, maxVersions }: LocalRevisionHistoryConfig,
) {
	// CRITICAL: Snapshots require gc: false
	if (ydoc.gc) {
		throw new Error(
			`[RevisionHistory] Garbage collection must be disabled for revision history to work. ` +
				`Create the Y.Doc with { gc: false } or set ydoc.gc = false before initializing.`,
		);
	}

	// Storage: {directory}/{workspaceId}/snapshots/
	const snapshotDir = path.join(directory, id, 'snapshots');

	// Ensure directory exists
	await mkdir(snapshotDir, { recursive: true });

	// Track last snapshot to avoid duplicates
	let lastSnapshot: Y.Snapshot | null = null;

	// Debounce state
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Save the current document state as a new version.
	 *
	 * Only saves if the document has changed since the last snapshot.
	 * Uses `Y.equalSnapshots()` to detect changes.
	 *
	 * @param description - Optional description for this version
	 * @returns The version entry if saved, null if no changes
	 */
	async function save(description?: string): Promise<VersionEntry | null> {
		const snapshot = Y.snapshot(ydoc);

		// Skip if no changes since last snapshot
		if (lastSnapshot && Y.equalSnapshots(lastSnapshot, snapshot)) {
			return null;
		}

		const timestamp = Date.now();
		const filename = `${timestamp}${SNAPSHOT_EXTENSION}`;
		const filePath = path.join(snapshotDir, filename);

		// Encode and save
		const encoded = Y.encodeSnapshot(snapshot);
		await Bun.write(filePath, encoded);

		// Save metadata to sidecar .json file if description provided
		if (description) {
			const metadataPath = path.join(
				snapshotDir,
				`${timestamp}${METADATA_EXTENSION}`,
			);
			const metadata: SnapshotMetadata = { description };
			await Bun.write(metadataPath, JSON.stringify(metadata));
		}

		// Update tracking
		lastSnapshot = snapshot;

		// Prune old versions if maxVersions is set
		if (maxVersions !== undefined) {
			void pruneOldVersions();
		}

		const entry: VersionEntry = {
			timestamp,
			description,
			size: encoded.byteLength,
			filename,
		};

		console.log(
			`[RevisionHistory] Saved version: ${timestamp}${description ? ` (${description})` : ''}`,
		);

		return entry;
	}

	/**
	 * Get all saved versions, sorted by timestamp (oldest first).
	 *
	 * @returns Array of version entries
	 */
	async function list(): Promise<VersionEntry[]> {
		const files = await readdir(snapshotDir, { withFileTypes: true });

		const versions: VersionEntry[] = [];

		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(SNAPSHOT_EXTENSION)) continue;

			const timestamp = parseInt(file.name.replace(SNAPSHOT_EXTENSION, ''), 10);
			if (isNaN(timestamp)) continue;

			const filePath = path.join(snapshotDir, file.name);
			const stat = await Bun.file(filePath).stat();

			// Read metadata from sidecar .json file if it exists
			const metadataPath = path.join(
				snapshotDir,
				`${timestamp}${METADATA_EXTENSION}`,
			);
			let description: string | undefined;
			const metadataFile = Bun.file(metadataPath);
			if (await metadataFile.exists()) {
				try {
					const metadata = JSON.parse(
						await metadataFile.text(),
					) as SnapshotMetadata;
					description = metadata.description;
				} catch {
					// Ignore malformed metadata
				}
			}

			versions.push({
				timestamp,
				description,
				size: stat?.size ?? 0,
				filename: file.name,
			});
		}

		// Sort by timestamp ascending (oldest first)
		versions.sort((a, b) => a.timestamp - b.timestamp);

		return versions;
	}

	/**
	 * Delete old versions to stay within maxVersions limit.
	 */
	async function pruneOldVersions(): Promise<void> {
		if (maxVersions === undefined) return;

		const versions = await list();

		if (versions.length <= maxVersions) return;

		// Delete oldest versions
		const toDelete = versions.slice(0, versions.length - maxVersions);

		for (const version of toDelete) {
			const snapshotPath = path.join(snapshotDir, version.filename);
			const metadataPath = path.join(
				snapshotDir,
				`${version.timestamp}${METADATA_EXTENSION}`,
			);

			try {
				await Bun.file(snapshotPath).delete();
				// Also delete metadata file if it exists
				const metadataFile = Bun.file(metadataPath);
				if (await metadataFile.exists()) {
					await metadataFile.delete();
				}
				console.log(
					`[RevisionHistory] Pruned old version: ${version.timestamp}`,
				);
			} catch {
				// Ignore deletion errors
			}
		}
	}

	// Subscribe to Y.Doc updates for debounced auto-save
	const updateHandler = () => {
		// Reset debounce timer on each update
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		// Schedule save after debounce interval
		debounceTimer = setTimeout(async () => {
			await save();
			debounceTimer = null;
		}, debounceMs);
	};
	ydoc.on('update', updateHandler);

	// Save initial snapshot to capture state before any edits
	await save();

	console.log(
		`[RevisionHistory] Initialized with ${debounceMs}ms debounce, saving to ${snapshotDir}`,
	);

	return {
		/**
		 * Save the current document state as a new version.
		 * Only saves if changes detected since last snapshot.
		 * Bypasses debounce for immediate save.
		 */
		save,

		/**
		 * Get all saved versions, sorted by timestamp (oldest first).
		 */
		list,

		/**
		 * Get a read-only Y.Doc at a specific version index.
		 *
		 * The returned document is a snapshot view and should NOT be modified.
		 * Use this for previewing historical states.
		 *
		 * @param index - Version index (0 = oldest)
		 * @returns Read-only Y.Doc at that version
		 */
		async view(index: number): Promise<Y.Doc> {
			const versions = await list();

			if (index < 0 || index >= versions.length) {
				throw new Error(
					`[RevisionHistory] Version index ${index} out of range (0-${versions.length - 1})`,
				);
			}

			// biome-ignore lint/style/noNonNullAssertion: Safe to use ! here - we've validated index is in bounds
			const version = versions[index]!;
			const filePath = path.join(snapshotDir, version.filename);

			const encoded = await Bun.file(filePath).arrayBuffer();
			const snapshot = Y.decodeSnapshot(new Uint8Array(encoded));

			// Create read-only doc from snapshot
			return Y.createDocFromSnapshot(ydoc, snapshot);
		},

		/**
		 * Restore the document to a specific version.
		 *
		 * This creates a new Y.Doc from the snapshot and applies its state
		 * to the current document. The restoration itself becomes a new
		 * change that will sync to other clients.
		 *
		 * @param index - Version index (0 = oldest)
		 */
		async restore(index: number): Promise<void> {
			const versions = await list();

			if (index < 0 || index >= versions.length) {
				throw new Error(
					`[RevisionHistory] Version index ${index} out of range (0-${versions.length - 1})`,
				);
			}

			// biome-ignore lint/style/noNonNullAssertion: Safe to use ! here - we've validated index is in bounds
			const version = versions[index]!;
			const filePath = path.join(snapshotDir, version.filename);

			const encoded = await Bun.file(filePath).arrayBuffer();
			const snapshot = Y.decodeSnapshot(new Uint8Array(encoded));

			// Create a fresh doc from the snapshot
			const restoredDoc = Y.createDocFromSnapshot(ydoc, snapshot);

			// Get the state as an update and apply to current doc
			const update = Y.encodeStateAsUpdate(restoredDoc);
			Y.applyUpdate(ydoc, update);

			console.log(
				`[RevisionHistory] Restored to version: ${version.timestamp}`,
			);
		},

		/**
		 * Get the count of saved versions.
		 */
		async count(): Promise<number> {
			const versions = await list();
			return versions.length;
		},

		/**
		 * The directory where snapshots are stored.
		 */
		directory: snapshotDir,

		/**
		 * Cleanup: cancel pending debounce and remove Y.Doc listener.
		 */
		destroy() {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			ydoc.off('update', updateHandler);
		},
	};
}
