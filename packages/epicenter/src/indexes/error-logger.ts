import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { TaggedError } from 'wellcrafted/error';
import { Ok, tryAsync, trySync } from 'wellcrafted/result';

/**
 * Log entry format: timestamp + full tagged error
 */
type LogEntry = {
	timestamp: string;
} & TaggedError;

/**
 * Configuration for creating an index logger
 */
type IndexLoggerConfig = {
	/**
	 * Absolute path to the log file where errors will be written.
	 *
	 * Example: `/path/to/storage/.epicenter/markdown/workspace-id.log`
	 *
	 * The parent directory will be created automatically if it doesn't exist.
	 */
	logPath: string;
};

type IndexLogger = {
	/**
	 * Log an error to the index-specific log file.
	 *
	 * This is synchronous from the caller's perspective. Errors are queued
	 * internally and written to disk asynchronously in FIFO order.
	 *
	 * Safe to call from multiple locations concurrently.
	 *
	 * @param error - The tagged error to log
	 */
	log(error: TaggedError): void;

	/**
	 * Close the logger and flush all pending entries.
	 *
	 * Ensures all queued log entries are written to disk before the file
	 * handle is closed. Call this once during application shutdown.
	 *
	 * Multiple concurrent calls to `close()` will wait for the same
	 * drain operation (they share a single promise).
	 */
	close(): Promise<void>;
};

/**
 * Create a logger for index errors
 *
 * Each log entry is a single JSON line with ISO timestamp + the full tagged error.
 * This provides a historical record of all errors for debugging and analysis.
 *
 * ## Queue-Based Architecture
 *
 * ```
 * log() calls are synchronous    drain() runs async in background
 *         |                                |
 *         v                                v
 *   +-----------+                   +------------+
 *   |  log(e1)  | --push-->  queue  |   drain()  | --write--> disk
 *   |  log(e2)  | --push-->  [e1]   |   while()  |
 *   |  log(e3)  | --push-->  [e2]   |   shift()  |
 *   +-----------+            [e3]   +------------+
 *         |                                |
 *         +--- queueMicrotask() ---------->+
 * ```
 *
 * - `log()` pushes to queue and schedules drain via `queueMicrotask()`
 * - `drain()` processes entries one at a time in FIFO order
 * - Only one drain runs at a time (guarded by `isDraining` flag)
 * - `close()` waits for drain to complete before closing file handle
 *
 * ## Why `queueMicrotask`?
 *
 * Multiple synchronous `log()` calls batch naturally:
 * ```
 * logger.log(e1);  // pushes, schedules drain
 * logger.log(e2);  // pushes, schedules drain (but guard skips duplicate)
 * logger.log(e3);  // pushes, schedules drain (but guard skips duplicate)
 * // microtask runs once, processes all three in order
 * ```
 *
 * Microtasks run after current sync code but before next event loop tick,
 * so logging stays responsive without blocking I/O.
 *
 * ## Purpose
 *
 * Historical audit trail of all errors:
 * - Append-only (never clears)
 * - Tracks patterns, frequency, timing
 * - Useful for debugging intermittent issues
 * - Answers "what happened over time?"
 *
 * Complements diagnostics manager:
 * - Diagnostics: current state (what's broken now)
 * - Logger: historical record (what broke when)
 *
 * ## Console Output Format
 *
 * `[ErrorName] message` + context object
 *
 * ```
 * [IndexError] File watcher: validation failed for posts/draft.md { filePath: '...', tableName: 'posts' }
 * [IndexError] YJS observer onAdd: failed to write posts/123 { tableName: 'posts', rowId: '123' }
 * ```
 *
 * @param config.logPath - Absolute path to the log file (parent directory created if needed)
 *
 * @example
 * ```typescript
 * const logger = createIndexLogger({
 *   logPath: path.join(storageDir, '.epicenter', 'markdown', `${workspaceId}.log`)
 * });
 *
 * // Synchronous: doesn't block, queues internally
 * logger.log(IndexError({
 *   message: 'File watcher: validation failed',
 *   context: { filePath: '...', tableName: 'posts' }
 * }));
 *
 * // Before shutdown, ensure all logs are written
 * await logger.close();
 * ```
 */
export function createIndexLogger({ logPath }: IndexLoggerConfig): IndexLogger {
	// Create parent directory if it doesn't exist
	const logDir = path.dirname(logPath);
	trySync({
		try: () => {
			mkdirSync(logDir, { recursive: true });
		},
		catch: () => Ok(undefined), // Directory might already exist
	});

	const file = Bun.file(logPath);
	const writer = file.writer();

	// ─────────────────────────────────────────────────────────────────────────
	// Queue State
	// ─────────────────────────────────────────────────────────────────────────

	/** Pending log entries waiting to be written to disk */
	const queue: LogEntry[] = [];

	/** True while drain() is actively processing the queue */
	let isDraining = false;

	/**
	 * Shared promise for the current drain operation.
	 *
	 * Multiple `close()` calls can await the same promise, ensuring they all
	 * wait for the same drain to complete rather than starting duplicate drains.
	 * Cleared via `.finally()` when drain completes.
	 */
	let drainPromise: Promise<void> | null = null;

	// ─────────────────────────────────────────────────────────────────────────
	// Internal: drain()
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Process the queue one entry at a time, in FIFO order.
	 *
	 * Only one drain loop runs at a time. The `isDraining` guard prevents
	 * concurrent drains even if multiple `queueMicrotask(() => drain())`
	 * calls are scheduled.
	 */
	async function drain(): Promise<void> {
		if (isDraining) return;
		isDraining = true;

		while (queue.length > 0) {
			const entry = queue.shift()!;

			await tryAsync({
				try: async () => {
					writer.write(`${JSON.stringify(entry)}\n`);
					await writer.flush();
				},
				catch: (writeError) => {
					console.error('Failed to write to error log:', writeError);
					return Ok(undefined);
				},
			});
		}

		isDraining = false;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Public API
	// ─────────────────────────────────────────────────────────────────────────

	return {
		log(error) {
			// Always output to console for immediate visibility
			console.error(`[${error.name}] ${error.message}`, error.context);

			// Queue the entry with timestamp
			queue.push({
				timestamp: new Date().toISOString(),
				...error,
			});

			// Schedule drain to run after current sync code completes.
			// If drain is already running, the isDraining guard will skip.
			queueMicrotask(() => drain());
		},

		async close() {
			// Nothing to wait for if queue is empty and not draining
			if (queue.length === 0 && !isDraining) {
				writer.end();
				return;
			}

			// Ensure drain is running and wait for it to complete.
			// Multiple close() calls share the same drainPromise.
			if (!drainPromise) {
				drainPromise = drain().finally(() => {
					drainPromise = null;
				});
			}
			await drainPromise;

			writer.end();
		},
	};
}
