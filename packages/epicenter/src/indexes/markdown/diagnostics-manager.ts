import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Ok, tryAsync, trySync } from 'wellcrafted/result';
import type { AbsolutePath } from '../../core/types';
import type { MarkdownIndexError } from './markdown-index';

/**
 * Diagnostic entry tracking a markdown file that failed validation
 *
 * Each entry represents a file that currently doesn't match its schema.
 * Entries are added when validation fails and removed when files are fixed or deleted.
 */
export type DiagnosticEntry = {
	/**
	 * Absolute path to the markdown file
	 * Used as the unique key for tracking
	 */
	filePath: AbsolutePath;

	/**
	 * Table name this file belongs to (e.g., "posts", "pages")
	 */
	tableName: string;

	/**
	 * Simple filename without directory path (e.g., "broken-post.md")
	 */
	filename: string;

	/**
	 * The validation error that occurred
	 */
	error: MarkdownIndexError;

	/**
	 * ISO 8601 timestamp when this error was first recorded
	 */
	timestamp: string;
};

/**
 * On-disk format: JSON object keyed by file path
 *
 * This allows O(1) lookups and makes the file human-readable for debugging.
 * Example:
 * ```json
 * {
 *   "/absolute/path/to/posts/broken.md": {
 *     "filePath": "/absolute/path/to/posts/broken.md",
 *     "tableName": "posts",
 *     "filename": "broken.md",
 *     "error": { ... },
 *     "timestamp": "2025-01-13T12:00:00.000Z"
 *   }
 * }
 * ```
 */
type DiagnosticsFile = Record<string, DiagnosticEntry>;

/**
 * Diagnostics manager API
 *
 * Manages a live index of markdown files that currently fail validation.
 * All mutations are non-blocking and queue disk writes sequentially.
 */
export type DiagnosticsManager = {
	/**
	 * Add or update a diagnostic entry (non-blocking)
	 *
	 * Called when a file fails validation. If the file is already tracked,
	 * updates the entry with the new error and timestamp.
	 *
	 * This operation is synchronous (updates in-memory state immediately)
	 * but queues a disk write to happen sequentially in the background.
	 *
	 * @param entry - Diagnostic entry (timestamp will be added automatically)
	 */
	add(entry: Omit<DiagnosticEntry, 'timestamp'>): void;

	/**
	 * Remove a diagnostic entry (non-blocking)
	 *
	 * Called when a file is fixed (passes validation) or deleted from disk.
	 * If the file is not tracked, this is a no-op.
	 *
	 * This operation is synchronous (updates in-memory state immediately)
	 * but queues a disk write to happen sequentially in the background.
	 *
	 * @param params.filePath - Absolute path to the file
	 */
	remove(params: { filePath: AbsolutePath }): void;

	/**
	 * Clear all diagnostic entries (non-blocking)
	 *
	 * Called at the start of full scans (startup, pushFromMarkdown) to reset state.
	 *
	 * This operation is synchronous (updates in-memory state immediately)
	 * but queues a disk write to happen sequentially in the background.
	 */
	clear(): void;

	/**
	 * Check if a file has a diagnostic entry
	 *
	 * @param params.filePath - Absolute path to the file
	 * @returns true if the file is currently tracked as invalid
	 */
	has(params: { filePath: AbsolutePath }): boolean;

	/**
	 * Get a specific diagnostic entry
	 *
	 * @param params.filePath - Absolute path to the file
	 * @returns The diagnostic entry, or undefined if not found
	 */
	get(params: { filePath: AbsolutePath }): DiagnosticEntry | undefined;

	/**
	 * Get all diagnostic entries as an array
	 *
	 * Useful for displaying all current validation errors to the user.
	 *
	 * @returns Array of all diagnostic entries
	 */
	getAll(): DiagnosticEntry[];

	/**
	 * Get count of diagnostic entries
	 *
	 * @returns Number of files currently tracked as invalid
	 */
	count(): number;

	/**
	 * Wait for all queued writes to complete
	 *
	 * Useful for testing or shutdown, but generally not needed since
	 * writes happen automatically in the background.
	 *
	 * @returns Promise that resolves when all pending writes are done
	 */
	flush(): Promise<void>;
};

/**
 * Configuration for creating a diagnostics manager
 */
type DiagnosticsManagerConfig = {
	/**
	 * Path to the diagnostics JSON file (can be relative or absolute)
	 *
	 * Example: `/path/to/storage/.epicenter/markdown/workspace-id-diagnostics.json`
	 *
	 * The parent directory will be created automatically if it doesn't exist.
	 */
	diagnosticsPath: string;
};

/**
 * Create a diagnostics manager for tracking markdown validation errors
 *
 * The manager maintains a live index of files that currently fail validation.
 * This is fundamentally different from an append-only log:
 *
 * - **Purpose**: Track current state (which files are broken right now)
 * - **Updates**: Add entries on validation failure, remove when fixed/deleted
 * - **Persistence**: Writes queued and executed sequentially in background
 * - **Lifecycle**: Rebuilt on startup, maintained by file watchers
 *
 * **Data structure**:
 * - In-memory: `Map<AbsolutePath, DiagnosticEntry>` for O(1) operations
 * - On-disk: JSON object keyed by file path for human readability
 *
 * **Non-blocking design**:
 * All mutations (add/remove/clear) are synchronous and return immediately.
 * Disk writes are queued and executed sequentially in the background.
 * This prevents mutations from blocking the caller while ensuring writes
 * happen in order (no race conditions).
 *
 * **Usage pattern**:
 * ```typescript
 * const diagnostics = createDiagnosticsManager({
 *   diagnosticsPath: '/path/to/diagnostics.json'
 * });
 *
 * // Non-blocking: returns immediately
 * diagnostics.add({
 *   filePath: '/path/to/broken.md',
 *   tableName: 'posts',
 *   filename: 'broken.md',
 *   error: MarkdownIndexError({ ... })
 * });
 *
 * // Non-blocking: returns immediately
 * diagnostics.remove({ filePath: '/path/to/broken.md' });
 *
 * // Get current state (reads in-memory map)
 * const allErrors = diagnostics.getAll();
 * console.log(`${diagnostics.count()} files currently invalid`);
 *
 * // Wait for all writes to complete (optional, for testing/shutdown)
 * await diagnostics.flush();
 * ```
 *
 * @param config.diagnosticsPath - Path to diagnostics file (relative or absolute, parent directory created if needed)
 * @returns Diagnostics manager instance
 */
export function createDiagnosticsManager({
	diagnosticsPath,
}: DiagnosticsManagerConfig): DiagnosticsManager {
	/**
	 * In-memory map: file path → diagnostic entry
	 *
	 * This is the source of truth during runtime. All operations modify this map
	 * synchronously, then queue a disk write. Using a Map provides O(1) operations.
	 */
	const diagnosticsMap = new Map<AbsolutePath, DiagnosticEntry>();

	/**
	 * Sequential write queue
	 *
	 * This promise chain ensures writes happen in order. Each write waits for
	 * the previous one to complete before starting. This prevents concurrent
	 * writes from corrupting the file.
	 *
	 * Pattern:
	 * - Start with a resolved promise
	 * - Each mutation appends `.then(write)` to the chain
	 * - Errors are caught and logged, but don't break the chain
	 */
	let writeQueue = Promise.resolve();

	// Create parent directory if it doesn't exist
	const diagnosticsDir = path.dirname(diagnosticsPath);
	trySync({
		try: () => {
			mkdirSync(diagnosticsDir, { recursive: true });
		},
		catch: () => Ok(undefined), // Directory might already exist
	});

	/**
	 * Load existing diagnostics from disk on initialization
	 *
	 * If the file exists, load it into the in-memory map. If it doesn't exist
	 * or is corrupted, start with an empty map.
	 *
	 * Note: This will be replaced by a full scan on startup, but loading the
	 * existing file first provides a starting point in case the scan fails.
	 */
	const { data: existingDiagnostics } = trySync({
		try: () => {
			const file = Bun.file(diagnosticsPath);
			const exists = file.size > 0; // Bun.file.exists is async, use size check
			if (!exists) return {};
			const content = Bun.file(diagnosticsPath).text();
			return JSON.parse(content) as DiagnosticsFile;
		},
		catch: () => {
			// File doesn't exist or is corrupted, start fresh
			return Ok({} as DiagnosticsFile);
		},
	});

	// Populate in-memory map from disk
	if (existingDiagnostics) {
		for (const [filePath, entry] of Object.entries(existingDiagnostics)) {
			diagnosticsMap.set(filePath as AbsolutePath, entry);
		}
	}

	/**
	 * Write the in-memory map to disk as JSON
	 *
	 * Converts the Map to a plain object for JSON serialization.
	 * If the write fails, logs an error but doesn't throw (best effort).
	 *
	 * This function is called by the write queue, not directly by users.
	 *
	 * Performance: O(n) where n = number of diagnostic entries
	 * Expected: <100 entries, so this is very fast
	 */
	async function writeToDisk(): Promise<void> {
		await tryAsync({
			try: async () => {
				// Convert Map to plain object for JSON serialization
				const diagnosticsObject: DiagnosticsFile = {};
				for (const [filePath, entry] of diagnosticsMap.entries()) {
					diagnosticsObject[filePath] = entry;
				}

				// Write to disk (Bun.write creates parent directories automatically)
				await Bun.write(
					diagnosticsPath,
					JSON.stringify(diagnosticsObject, null, 2),
				);
			},
			catch: (error) => {
				// If write fails, log error but don't throw
				// In-memory state is still accurate
				console.error('Failed to write diagnostics to disk:', error);
				console.error('Diagnostics path:', diagnosticsPath);
				return Ok(undefined);
			},
		});
	}

	/**
	 * Queue a write operation to happen sequentially
	 *
	 * Appends the write to the promise chain. Each write waits for the previous
	 * one to complete. Errors are caught and logged, but don't break the chain.
	 *
	 * This helper function encapsulates the queue management pattern:
	 * 1. Take the current queue promise
	 * 2. Append `.then(operation)` to it
	 * 3. Catch errors to prevent breaking the chain
	 * 4. Update queue to point to the new promise
	 *
	 * @param operation - Async operation to queue (usually writeToDisk)
	 */
	function queueWrite(operation: () => Promise<void>): void {
		writeQueue = writeQueue.then(operation).catch((error) => {
			// Log error but don't break the queue
			console.error('Queued write operation failed:', error);
		});
	}

	return {
		add(entry) {
			// Synchronous: update in-memory map immediately
			const fullEntry: DiagnosticEntry = {
				...entry,
				timestamp: new Date().toISOString(),
			};
			diagnosticsMap.set(entry.filePath, fullEntry);

			// Asynchronous: queue disk write to happen in background
			queueWrite(() => writeToDisk());
		},

		remove({ filePath }) {
			// Synchronous: update in-memory map immediately
			const wasPresent = diagnosticsMap.delete(filePath);

			// Asynchronous: queue disk write if something changed
			if (wasPresent) {
				queueWrite(() => writeToDisk());
			}
		},

		clear() {
			// Synchronous: clear in-memory map immediately
			diagnosticsMap.clear();

			// Asynchronous: queue disk write to happen in background
			queueWrite(() => writeToDisk());
		},

		has({ filePath }) {
			return diagnosticsMap.has(filePath);
		},

		get({ filePath }) {
			return diagnosticsMap.get(filePath);
		},

		getAll() {
			return Array.from(diagnosticsMap.values());
		},

		count() {
			return diagnosticsMap.size;
		},

		flush() {
			// Return the current queue promise
			// Caller can await this to ensure all writes are done
			return writeQueue;
		},
	};
}
