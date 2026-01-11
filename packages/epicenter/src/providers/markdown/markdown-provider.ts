import { mkdirSync } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync, trySync } from 'wellcrafted/result';
import type { TableHelper } from '../../core/db/core';
import { ProviderErr, ProviderError } from '../../core/errors';
import {
	defineProviders,
	type Provider,
	type ProviderContext,
} from '../../core/provider.shared';
import type {
	Row,
	SerializedRow,
	TableSchema,
	TablesSchema,
} from '../../core/schema';
import type { AbsolutePath } from '../../core/types';
import { createIndexLogger } from '../error-logger';
import {
	defaultSerializer,
	type MarkdownSerializer,
	type TableMarkdownConfig,
} from './configs';
import { createDiagnosticsManager } from './diagnostics-manager';
import {
	deleteMarkdownFile,
	listMarkdownFiles,
	readMarkdownFile,
	writeMarkdownFile,
} from './io';

/**
 * Error types for markdown provider diagnostics
 * Used to track files that fail to process during indexing
 *
 * Context is optional since some errors (like read failures) may not
 * have all the structured data (fileName, id, reason) available.
 */
type MarkdownProviderContext = {
	fileName: string;
	id: string;
	reason: string;
};

export const { MarkdownProviderError, MarkdownProviderErr } = createTaggedError(
	'MarkdownProviderError',
).withContext<MarkdownProviderContext | undefined>();
export type MarkdownProviderError = ReturnType<typeof MarkdownProviderError>;

// Re-export config types and functions
export type {
	BodyFieldSerializerOptions,
	MarkdownSerializer,
	ParsedFilename,
	TableMarkdownConfig,
	TitleFilenameSerializerOptions,
} from './configs';
export {
	// Pre-built serializer factories
	bodyFieldSerializer,
	defaultSerializer,
	// Builder for custom serializers with full type inference
	defineSerializer,
	titleFilenameSerializer,
} from './configs';

/**
 * Bidirectional sync coordination state
 *
 * Prevents infinite loops during two-way synchronization between YJS (in-memory)
 * and markdown files (on disk). Without this coordination:
 *
 * 1. YJS change → writes markdown file → triggers file watcher
 * 2. File watcher → updates YJS → triggers YJS observer
 * 3. YJS observer → writes markdown file → back to step 1 (infinite loop)
 *
 * The state ensures changes only flow in one direction at a time by tracking
 * which system is currently processing changes.
 *
 * Why counters instead of booleans:
 * Multiple async operations can run concurrently. A boolean causes race conditions:
 * - Event A sets flag = true, awaits async work
 * - Event B sets flag = true, awaits async work
 * - Event A completes, sets flag = false (BUG! B is still working)
 * - Observer sees false, processes B's side effect, creates infinite loop
 *
 * With counters:
 * - Event A increments to 1, awaits async work
 * - Event B increments to 2, awaits async work
 * - Event A completes, decrements to 1 (still > 0, protected)
 * - Event B completes, decrements to 0
 */
type SyncCoordination = {
	/**
	 * Counter for concurrent file watcher handlers updating YJS.
	 * YJS observers check this and skip processing when > 0.
	 */
	fileChangeCount: number;

	/**
	 * Counter for concurrent YJS observers writing to disk.
	 * File watcher checks this and skips processing when > 0.
	 */
	yjsWriteCount: number;
};

/**
 * Unidirectional map from row ID to filename
 *
 * Used to track the current filename for each row. This is needed to detect
 * filename changes when a row is updated (e.g., title change in withTitleFilename).
 *
 * The reverse direction (filename → rowId) is handled by parseFilename,
 * which extracts structured data (including the row ID) from the filename string.
 */
type RowToFilenameMap = Record<string, string>;

/**
 * Per-table markdown configuration.
 *
 * Each table config has two optional fields:
 * - `directory?`: WHERE files go (defaults to table name)
 * - `serializer?`: HOW rows are encoded/decoded (defaults to all-frontmatter)
 *
 * Use serializer factories like `bodyFieldSerializer()` or `titleFilenameSerializer()`.
 */
type TableConfigs<TTablesSchema extends TablesSchema> = {
	[K in keyof TTablesSchema]?: TableMarkdownConfig<TTablesSchema[K]>;
};

/**
 * Internal resolved config with all required fields.
 * This is what the provider uses internally after merging user config with defaults.
 */
type ResolvedTableConfig<TTableSchema extends TableSchema> = {
	directory: AbsolutePath;
	serialize: MarkdownSerializer<TTableSchema>['serialize'];
	parseFilename: MarkdownSerializer<TTableSchema>['deserialize']['parseFilename'];
	deserialize: MarkdownSerializer<TTableSchema>['deserialize']['fromContent'];
};

/**
 * Markdown provider configuration
 */
export type MarkdownProviderConfig<
	TTablesSchema extends TablesSchema = TablesSchema,
> = {
	/**
	 * Workspace-level directory where markdown files should be stored.
	 *
	 * **Optional**: Defaults to the workspace `id` if not provided
	 * ```typescript
	 * // If workspace id is "blog", defaults to "<projectDir>/blog"
	 * markdownProvider({ id, db, projectDir })
	 * ```
	 *
	 * **Three ways to specify the path**:
	 *
	 * **Option 1: Relative paths** (recommended): Resolved relative to projectDir from epicenter config
	 * ```typescript
	 * directory: './vault'      // → <projectDir>/vault
	 * directory: '../content'   // → <projectDir>/../content
	 * ```
	 *
	 * **Option 2: Absolute paths**: Used as-is, no resolution needed
	 * ```typescript
	 * directory: '/absolute/path/to/vault'
	 * ```
	 *
	 * **Option 3: Relative to current file**: Use import.meta.dirname to create absolute path relative to the workspace file
	 * ```typescript
	 * // In workspace.ts, places files in ./vault folder next to workspace.ts
	 * directory: path.join(import.meta.dirname, './vault')
	 * ```
	 *
	 * Each table's directory will be resolved relative to this workspace directory (unless the table uses an absolute path).
	 *
	 * @default `./${id}` where id is the workspace ID
	 */
	directory?: string;

	/**
	 * Per-table markdown configuration.
	 *
	 * Defines how each table is serialized to markdown files and deserialized back.
	 * Tables without custom configuration use default behavior:
	 * - Directory: `{tableName}` (relative to workspace directory)
	 * - Serialize: all fields in frontmatter, empty body, filename `{id}.md`
	 * - Deserialize: extract ID from filename, validate all frontmatter fields
	 *
	 * Example:
	 * ```typescript
	 * {
	 *   posts: {
	 *     directory: './blog-posts', // relative to workspace directory
	 *     serialize: ({ row, table }) => ({
	 *       frontmatter: { title: row.title, date: row.createdAt },
	 *       body: row.content,
	 *       filename: `${row.id}.md`
	 *     }),
	 *     deserialize: ({ frontmatter, body, filename, table }) => {
	 *       const id = path.basename(filename, '.md');
	 *       return Ok({ id, title: frontmatter.title, content: body });
	 *     }
	 *   }
	 * }
	 * ```
	 */
	configs?: TableConfigs<TTablesSchema>;

	/**
	 * Enable verbose debug logging for troubleshooting file sync issues.
	 *
	 * When enabled, logs:
	 * - Every chokidar event (add, change, unlink)
	 * - Handler entry/exit with filename
	 * - Early returns (skipped files, duplicates, validation failures)
	 * - Sync coordination state (yjsWriteCount, fileChangeCount)
	 *
	 * Useful for debugging bulk file operations where some files don't sync.
	 *
	 * @default false
	 */
	debug?: boolean;
};

export const markdownProvider = (async <TTablesSchema extends TablesSchema>(
	context: ProviderContext<TTablesSchema>,
	config: MarkdownProviderConfig<TTablesSchema> = {},
) => {
	const { id, providerId, tables, paths } = context;
	const { directory = `./${id}`, debug = false } = config;

	// Debug logger - no-op when debug is disabled
	const dbg = debug
		? (tag: string, msg: string, data?: Record<string, unknown>) => {
				const timestamp = new Date().toISOString().slice(11, 23);
				console.log(`[MD:${tag}] ${timestamp} ${msg}`, data ?? '');
			}
		: () => {};

	// User-provided table configs (sparse - only contains overrides, may be empty)
	// Access via userTableConfigs[tableName] returns undefined when user didn't provide config
	const userTableConfigs: TableConfigs<TTablesSchema> = config.configs ?? {};

	if (!paths) {
		throw new Error(
			'Markdown provider requires Node.js environment with filesystem access',
		);
	}

	const { project: projectDir, epicenter: epicenterDir } = paths;

	// Workspace-specific directory for all provider artifacts
	// Structure: .epicenter/{workspaceId}/{providerId}.{suffix}
	const workspaceConfigDir = path.join(epicenterDir, id);

	// Create diagnostics manager for tracking validation errors (current state)
	const diagnostics = await createDiagnosticsManager({
		diagnosticsPath: path.join(
			workspaceConfigDir,
			`${providerId}.diagnostics.json`,
		),
	});

	// Create logger for historical error record (append-only audit trail)
	const logger = createIndexLogger({
		logPath: path.join(workspaceConfigDir, `${providerId}.log`),
	});

	// Resolve workspace directory to absolute path
	// If directory is relative, resolve it relative to projectDir
	// If directory is absolute, use it as-is
	const absoluteWorkspaceDir = path.resolve(
		projectDir,
		directory,
	) as AbsolutePath;

	/**
	 * Coordination state to prevent infinite sync loops
	 *
	 * How it works:
	 * - Before YJS observers write files: increment yjsWriteCount
	 *   - File watcher checks this and skips processing when > 0
	 * - Before file watcher updates YJS: increment fileChangeCount
	 *   - YJS observers check this and skip processing when > 0
	 */
	const syncCoordination: SyncCoordination = {
		fileChangeCount: 0,
		yjsWriteCount: 0,
	};

	/**
	 * Filename tracking: Maps row IDs → filenames for each table
	 *
	 * Structure: `Record<tableName, Record<rowId, filename>>`
	 *
	 * This is needed to detect filename changes when a row is updated:
	 * - Row "abc123" previously serialized to "draft.md"
	 * - Row is updated and now serializes to "published.md"
	 * - We need to know the OLD filename ("draft.md") so we can delete it
	 * - Without this: orphaned "draft.md" remains on disk
	 *
	 * The reverse direction (filename → rowId) is handled by parseFilename,
	 * which extracts structured data (including the row ID) from the filename string. This works for:
	 * - File deletions: Parse filename to get ID, delete from Y.js
	 * - Orphan detection: Parse filename to get ID, check if row exists in Y.js
	 */
	const tracking: Record<string, RowToFilenameMap> = {};

	/**
	 * Build resolved configs by merging user configs with defaults.
	 *
	 * User configs have two optional fields:
	 * - `directory?`: WHERE files go (defaults to table name)
	 * - `serializer?`: HOW rows are encoded/decoded (defaults to all-frontmatter)
	 *
	 * We resolve these to a flat internal structure for efficient runtime access.
	 * The result mirrors the tables structure key-for-key, enabling type-safe
	 * iteration via tables.$zip(resolvedConfigs).
	 */
	// Cast is correct: Object.fromEntries loses key specificity (returns { [k: string]: V }),
	// but we know keys are exactly keyof TTablesSchema since we iterate tables.$all().
	const resolvedConfigs = Object.fromEntries(
		tables.$all().map((table) => {
			const userConfig = userTableConfigs[table.name] ?? {};

			// Resolve serializer: user-provided or default
			const serializer = userConfig.serializer ?? defaultSerializer();

			// Resolve directory: user-provided or table name
			const directory = path.resolve(
				absoluteWorkspaceDir,
				userConfig.directory ?? table.name,
			) as AbsolutePath;

			// Flatten for internal use
			const config: ResolvedTableConfig<
				TTablesSchema[keyof TTablesSchema & string]
			> = {
				directory,
				serialize: serializer.serialize,
				parseFilename: serializer.deserialize.parseFilename,
				deserialize: serializer.deserialize.fromContent,
			};

			return [table.name, config];
		}),
	) as unknown as {
		[K in keyof TTablesSchema & string]: ResolvedTableConfig<TTablesSchema[K]>;
	};

	/**
	 * Register YJS observers to sync changes from YJS to markdown files
	 *
	 * When rows are added/updated/deleted in YJS, this writes the changes to corresponding
	 * markdown files on disk. Coordinates with the file watcher through shared state to
	 * prevent infinite sync loops.
	 */
	const registerYJSObservers = () => {
		const unsubscribers: Array<() => void> = [];

		for (const { table, paired: tableConfig } of tables.$zip(resolvedConfigs)) {
			// Initialize tracking map for this table
			if (!tracking[table.name]) {
				tracking[table.name] = {};
			}

			/**
			 * Write a YJS row to markdown file
			 */
			async function writeRowToMarkdown<TTableSchema extends TableSchema>(
				row: Row<TTableSchema>,
			) {
				const serialized = row.toJSON();

				const { frontmatter, body, filename } = tableConfig.serialize({
					// @ts-expect-error: TTableSchema doesn't correlate with tableConfig's schema from outer $zip
					row: serialized,
					table,
				});

				// Construct file path
				const filePath = path.join(
					tableConfig.directory,
					filename,
				) as AbsolutePath;

				// Check if we need to clean up an old file before updating tracking
				const oldFilename = tracking[table.name]?.[row.id];

				/**
				 * This is checking if there's an old filename AND if it's different
				 * from the new one. It's essentially checking: "has the filename
				 * changed?" and "do we need to clean up the old file?"
				 */
				const needsOldFileCleanup = oldFilename && oldFilename !== filename;
				if (needsOldFileCleanup) {
					const oldFilePath = path.join(
						tableConfig.directory,
						oldFilename,
					) as AbsolutePath;
					await deleteMarkdownFile({ filePath: oldFilePath });
				}

				// Update tracking (rowId → filename)
				// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
				tracking[table.name]![row.id] = filename;

				return writeMarkdownFile({
					filePath,
					frontmatter,
					body,
				});
			}

			const unsub = table.observe({
				onAdd: async (result) => {
					// Skip if this YJS change was triggered by a file change we're processing
					// (prevents markdown -> YJS -> markdown infinite loop)
					if (syncCoordination.fileChangeCount > 0) return;

					if (result.error) {
						// Handle validation errors with diagnostics + logger
						logger.log(
							ProviderError({
								message: `YJS observer onAdd: validation failed for ${table.name}`,
								context: result.error.context,
							}),
						);
						return;
					}

					const row = result.data;
					syncCoordination.yjsWriteCount++;
					const { error } = await writeRowToMarkdown(row);
					syncCoordination.yjsWriteCount--;

					if (error) {
						// Log I/O errors (operational errors, not validation errors)
						logger.log(
							ProviderError({
								message: `YJS observer onAdd: failed to write ${table.name}/${row.id}`,
								context: { tableName: table.name, rowId: row.id },
							}),
						);
					}
				},
				onUpdate: async (result) => {
					// Skip if this YJS change was triggered by a file change we're processing
					// (prevents markdown -> YJS -> markdown infinite loop)
					if (syncCoordination.fileChangeCount > 0) return;

					if (result.error) {
						// Handle validation errors with diagnostics + logger
						logger.log(
							ProviderError({
								message: `YJS observer onUpdate: validation failed for ${table.name}`,
								context: result.error.context,
							}),
						);
						return;
					}

					const row = result.data;
					syncCoordination.yjsWriteCount++;
					const { error } = await writeRowToMarkdown(row);
					syncCoordination.yjsWriteCount--;

					if (error) {
						// Log I/O errors (operational errors, not validation errors)
						logger.log(
							ProviderError({
								message: `YJS observer onUpdate: failed to write ${table.name}/${row.id}`,
								context: { tableName: table.name, rowId: row.id },
							}),
						);
					}
				},
				onDelete: async (id) => {
					// Skip if this YJS change was triggered by a file change we're processing
					// (prevents markdown -> YJS -> markdown infinite loop)
					if (syncCoordination.fileChangeCount > 0) return;

					syncCoordination.yjsWriteCount++;

					// Get filename and delete file if it exists
					const filename = tracking[table.name]?.[id];
					if (filename) {
						const filePath = path.join(
							tableConfig.directory,
							filename,
						) as AbsolutePath;
						const { error } = await deleteMarkdownFile({ filePath });

						// Clean up tracking
						// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
						delete tracking[table.name]![id];

						if (error) {
							// Log I/O errors (operational errors, not validation errors)
							logger.log(
								ProviderError({
									message: `YJS observer onDelete: failed to delete ${table.name}/${id}`,
									context: { tableName: table.name, rowId: id, filePath },
								}),
							);
						}
					}

					syncCoordination.yjsWriteCount--;
				},
			});
			unsubscribers.push(unsub);
		}

		return unsubscribers;
	};

	/**
	 * Register file watchers to sync changes from markdown files to YJS
	 *
	 * Uses chokidar for robust cross-platform file watching with:
	 * - awaitWriteFinish: Waits for files to be fully written before processing
	 * - atomic: Handles editor atomic writes (temp file → rename pattern)
	 *
	 * This solves race conditions with bulk operations (20+ files pasted at once)
	 * by ensuring files are stable before triggering sync events.
	 */
	const registerFileWatchers = () => {
		const watchers: FSWatcher[] = [];

		for (const { table, paired: tableConfig } of tables.$zip(resolvedConfigs)) {
			// Ensure table directory exists
			const { error: mkdirError } = trySync({
				try: () => {
					mkdirSync(tableConfig.directory, { recursive: true });
				},
				catch: (error) =>
					ProviderErr({
						message: `Failed to create table directory: ${extractErrorMessage(error)}`,
						context: {
							tableName: table.name,
							directory: tableConfig.directory,
						},
					}),
			});

			if (mkdirError) {
				logger.log(mkdirError);
			}

			// Create chokidar watcher with robust configuration
			const watcher = chokidar.watch(tableConfig.directory, {
				// Core settings
				persistent: true,
				ignoreInitial: true, // Don't fire events for existing files (we already did initial scan)
				followSymlinks: true,
				cwd: tableConfig.directory,

				// Performance settings
				usePolling: false, // Event-based is more efficient on macOS/Linux
				depth: 0, // Only watch direct children (markdown files in table directory)

				// Critical for reliability with bulk operations
				// Waits for files to be fully written before emitting events
				awaitWriteFinish: {
					stabilityThreshold: 500, // File must be stable for 500ms
					pollInterval: 100, // Check every 100ms
				},

				// Handle atomic writes (temp file → rename pattern used by many editors)
				atomic: true,

				// Ignore non-markdown files and OS artifacts
				ignored: [
					/(^|[/\\])\../, // Dotfiles (.DS_Store, .git, etc.)
					/\.swp$/, // Vim swap files
					/~$/, // Editor backup files
					/\.tmp$/, // Temp files
					// Only watch .md files
					(filePath: string) =>
						!filePath.endsWith('.md') &&
						!filePath.endsWith(tableConfig.directory),
				],
			});

			// Helper: Process file add/change
			const handleFileAddOrChange = async (filePath: string) => {
				const filename = path.basename(filePath);
				dbg('HANDLER', `START ${table.name}/${filename}`, {
					yjsWriteCount: syncCoordination.yjsWriteCount,
					fileChangeCount: syncCoordination.fileChangeCount,
				});

				// Skip if this file change was triggered by a YJS change
				if (syncCoordination.yjsWriteCount > 0) {
					dbg('HANDLER', `SKIP ${table.name}/${filename} (yjsWriteCount > 0)`);
					return;
				}

				syncCoordination.fileChangeCount++;

				try {
					const absolutePath = path.join(
						tableConfig.directory,
						filename,
					) as AbsolutePath;

					const { data: fileContent, error: readError } =
						await readMarkdownFile(absolutePath);

					if (readError) {
						dbg('HANDLER', `FAIL ${table.name}/${filename} (read error)`, {
							error: readError.message,
						});
						diagnostics.add({
							filePath: absolutePath,
							tableName: table.name,
							filename,
							error: MarkdownProviderError({
								message: `Failed to read markdown file at ${absolutePath}: ${readError.message}`,
							}),
						});
						logger.log(
							ProviderError({
								message: `File watcher: failed to read ${table.name}/${filename}`,
								context: {
									filePath: absolutePath,
									tableName: table.name,
									filename,
								},
							}),
						);
						return;
					}

					const { data: frontmatter, body } = fileContent;

					// Parse filename to extract structured data
					const parsed = tableConfig.parseFilename(filename);
					if (!parsed) {
						dbg('HANDLER', `FAIL ${table.name}/${filename} (parse error)`);
						const error = MarkdownProviderError({
							message: `Failed to parse filename: ${filename}`,
						});
						diagnostics.add({
							filePath: absolutePath,
							tableName: table.name,
							filename,
							error,
						});
						logger.log(
							ProviderError({
								message: `File watcher: failed to parse filename ${table.name}/${filename}`,
								context: {
									filePath: absolutePath,
									tableName: table.name,
									filename,
								},
							}),
						);
						return;
					}

					// Deserialize using the table config
					const { data: row, error: deserializeError } =
						tableConfig.deserialize({
							frontmatter,
							body,
							filename,
							parsed,
							table,
						});

					if (deserializeError) {
						dbg(
							'HANDLER',
							`FAIL ${table.name}/${filename} (validation error)`,
							{
								error: deserializeError.message,
							},
						);
						diagnostics.add({
							filePath: absolutePath,
							tableName: table.name,
							filename,
							error: deserializeError,
						});
						logger.log(
							ProviderError({
								message: `File watcher: validation failed for ${table.name}/${filename}`,
								context: {
									filePath: absolutePath,
									tableName: table.name,
									filename,
								},
							}),
						);
						return;
					}

					const validatedRow = row as SerializedRow<
						TTablesSchema[keyof TTablesSchema & string]
					>;

					// Success: remove from diagnostics if it was previously invalid
					diagnostics.remove({ filePath: absolutePath });

					// Check for duplicate files: same row ID but different filename
					// This happens when users copy-paste markdown files in Finder
					const existingFilename = tracking[table.name]?.[validatedRow.id];

					if (existingFilename && existingFilename !== filename) {
						// This is a duplicate file with the same ID - delete it
						dbg(
							'HANDLER',
							`SKIP ${table.name}/${filename} (duplicate of ${existingFilename})`,
							{
								rowId: validatedRow.id,
							},
						);
						logger.log(
							ProviderError({
								message: `Duplicate file detected: ${filename} has same ID as ${existingFilename}, deleting duplicate`,
								context: {
									tableName: table.name,
									filename,
									rowId: validatedRow.id,
								},
							}),
						);
						await deleteMarkdownFile({ filePath: absolutePath });
						return;
					}

					// Update tracking (rowId → filename) and upsert to Y.js
					// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
					tracking[table.name]![validatedRow.id] = filename;
					table.upsert(validatedRow);
					dbg('HANDLER', `SUCCESS ${table.name}/${filename}`, {
						rowId: validatedRow.id,
					});
				} finally {
					syncCoordination.fileChangeCount--;
				}
			};

			// Helper: Process file deletion
			const handleFileUnlink = (filePath: string) => {
				// Skip if this file change was triggered by a YJS change
				if (syncCoordination.yjsWriteCount > 0) return;

				syncCoordination.fileChangeCount++;

				try {
					const filename = path.basename(filePath);

					// Parse filename to extract row ID (single source of truth)
					const parsed = tableConfig.parseFilename(filename);
					const rowIdToDelete = parsed?.id;
					dbg('HANDLER', `UNLINK ${table.name}/${filename}`, {
						extractedRowId: rowIdToDelete ?? 'undefined',
					});

					if (rowIdToDelete) {
						if (table.has(rowIdToDelete)) {
							table.delete(rowIdToDelete);
							dbg(
								'HANDLER',
								`UNLINK deleted row ${table.name}/${rowIdToDelete}`,
							);
						} else {
							dbg(
								'HANDLER',
								`UNLINK row not in Y.js ${table.name}/${rowIdToDelete}`,
							);
						}

						// Clean up tracking (if it existed)
						// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
						delete tracking[table.name]![rowIdToDelete];
					} else {
						logger.log(
							ProviderError({
								message: `File deleted but could not parse row ID from ${table.name}/${filename}`,
								context: { tableName: table.name, filename },
							}),
						);
					}
				} finally {
					syncCoordination.fileChangeCount--;
				}
			};

			// Register event handlers with debug logging for raw events
			watcher
				.on('add', (filePath) => {
					dbg('CHOKIDAR', `add: ${table.name}/${path.basename(filePath)}`);
					handleFileAddOrChange(filePath);
				})
				.on('change', (filePath) => {
					dbg('CHOKIDAR', `change: ${table.name}/${path.basename(filePath)}`);
					handleFileAddOrChange(filePath);
				})
				.on('unlink', (filePath) => {
					dbg('CHOKIDAR', `unlink: ${table.name}/${path.basename(filePath)}`);
					handleFileUnlink(filePath);
				})
				.on('error', (error) => {
					dbg('CHOKIDAR', `error: ${table.name}`, {
						error: extractErrorMessage(error),
					});
					logger.log(
						ProviderError({
							message: `File watcher error for ${table.name}: ${extractErrorMessage(error)}`,
							context: {
								tableName: table.name,
								directory: tableConfig.directory,
							},
						}),
					);
				})
				.on('ready', () => {
					dbg(
						'CHOKIDAR',
						`ready: ${table.name} watching ${tableConfig.directory}`,
					);
				});

			watchers.push(watcher);
		}

		return watchers;
	};

	/**
	 * Validate all markdown files and rebuild diagnostics
	 *
	 * Scans every markdown file, validates it against the schema, and updates diagnostics
	 * to reflect current state. Used in three places:
	 * 1. Initial scan on startup (before watchers start)
	 * 2. Manual scan via scanForErrors query
	 * 3. Push operation after clearing YJS tables
	 *
	 * @param params.operation - Optional operation name for logging context
	 */
	async function validateAllMarkdownFiles(params?: {
		operation?: string;
	}): Promise<void> {
		const operationPrefix = params?.operation ? `${params.operation}: ` : '';

		diagnostics.clear();

		for (const { table, paired: tableConfig } of tables.$zip(resolvedConfigs)) {
			const filePaths = await listMarkdownFiles(tableConfig.directory);

			await Promise.all(
				filePaths.map(async (filePath) => {
					const filename = path.basename(filePath);

					const { data: fileContent, error: readError } =
						await readMarkdownFile(filePath);

					if (readError) {
						diagnostics.add({
							filePath,
							tableName: table.name,
							filename,
							error: MarkdownProviderError({
								message: `Failed to read markdown file at ${filePath}: ${readError.message}`,
							}),
						});
						logger.log(
							ProviderError({
								message: `${operationPrefix}failed to read ${table.name}/${filename}`,
								context: { filePath, tableName: table.name, filename },
							}),
						);
						return;
					}

					const { data: frontmatter, body } = fileContent;

					// Parse filename to extract structured data
					const parsed = tableConfig.parseFilename(filename);
					if (!parsed) {
						const error = MarkdownProviderError({
							message: `Failed to parse filename: ${filename}`,
						});
						diagnostics.add({
							filePath,
							tableName: table.name,
							filename,
							error,
						});
						logger.log(
							ProviderError({
								message: `${operationPrefix}failed to parse filename ${table.name}/${filename}`,
								context: { filePath, tableName: table.name, filename },
							}),
						);
						return;
					}

					// Deserialize using the table config
					const { error: deserializeError } = tableConfig.deserialize({
						frontmatter,
						body,
						filename,
						parsed,
						table,
					});

					if (deserializeError) {
						// Track validation error in diagnostics (current state)
						diagnostics.add({
							filePath,
							tableName: table.name,
							filename,
							error: deserializeError,
						});
						// Log to historical record
						logger.log(
							ProviderError({
								message: `${operationPrefix}validation failed for ${table.name}/${filename}`,
								context: { filePath, tableName: table.name, filename },
							}),
						);
					}
				}),
			);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// STARTUP SEQUENCE
	// ─────────────────────────────────────────────────────────────────────────────
	//
	// The startup sequence has 4 phases that MUST run in this exact order:
	//
	// ┌─────────────────────────────────────────────────────────────────────────┐
	// │ PHASE 1: Build Tracking Map (Y.js → Memory)                             │
	// │                                                                         │
	// │   For each Y.js row, compute the expected filename via serialize().     │
	// │   This builds the "source of truth" for what files SHOULD exist.        │
	// │                                                                         │
	// │   tracking[tableName] = { rowId ↔ filename } (bidirectional)            │
	// └─────────────────────────────────────────────────────────────────────────┘
	//                                    ↓
	// ┌─────────────────────────────────────────────────────────────────────────┐
	// │ PHASE 2: Delete Orphan Files (Disk vs Tracking)                         │
	// │                                                                         │
	// │   Scan disk files and delete any not in tracking map.                   │
	// │   These are orphans from crashes, copy-paste, or failed syncs.          │
	// │                                                                         │
	// │   if file on disk && file NOT in tracking → DELETE                      │
	// └─────────────────────────────────────────────────────────────────────────┘
	//                                    ↓
	// ┌─────────────────────────────────────────────────────────────────────────┐
	// │ PHASE 3: Start Watchers IMMEDIATELY (Runtime Sync)                      │
	// │                                                                         │
	// │   - Y.js observers: Y.js changes → write/delete markdown files          │
	// │   - File watchers: Markdown changes → upsert/delete Y.js rows           │
	// │                                                                         │
	// │   Start watchers as soon as tracking map is built and orphans deleted.  │
	// │   This eliminates startup delay - sync begins immediately.              │
	// └─────────────────────────────────────────────────────────────────────────┘
	//                                    ↓
	// ┌─────────────────────────────────────────────────────────────────────────┐
	// │ PHASE 4: Validate Remaining Files (BACKGROUND/NON-BLOCKING)             │
	// │                                                                         │
	// │   For each remaining file, deserialize and validate against schema.     │
	// │   Build diagnostics for any files with validation errors.               │
	// │                                                                         │
	// │   This runs in background - provider is already ready for sync.         │
	// └─────────────────────────────────────────────────────────────────────────┘
	//
	// WHY THIS ORDER MATTERS:
	//
	// - Phase 1 before Phase 2: We need tracking map to know which files are orphans
	// - Phase 2 before Phase 3: Orphans must be deleted before watchers start
	// - Phase 3 before Phase 4: Watchers need tracking map, validation can be deferred
	// - Phase 4 in background: Diagnostics don't block sync startup
	//
	// ─────────────────────────────────────────────────────────────────────────────

	/**
	 * PHASE 1: Build tracking map from Y.js
	 *
	 * Problem: The tracking map only exists in memory. On restart, Y.js data is
	 * restored from persistence, but the map is empty. Without this:
	 *
	 * 1. User edits a row → triggers onUpdate
	 * 2. We compute newFilename = "published.md"
	 * 3. We look up: oldFilename = tracking[tableName][rowId] → undefined (empty map!)
	 * 4. We think filename didn't change, skip old file cleanup
	 * 5. Result: Orphaned files accumulate
	 *
	 * Solution: Serialize all Y.js rows to rebuild the map.
	 *
	 * Cost: O(n × serialize) where n = row count. ~1ms per 100 rows.
	 */
	for (const { table, paired: tableConfig } of tables.$zip(resolvedConfigs)) {
		// Initialize tracking map for this table
		if (!tracking[table.name]) {
			tracking[table.name] = {};
		}

		// Get all valid rows from YJS
		const rows = table.getAllValid();

		// Serialize each row to extract filename and populate tracking (rowId → filename)
		for (const row of rows) {
			const serializedRow = row.toJSON();
			const { filename } = tableConfig.serialize({
				row: serializedRow,
				table,
			});

			// Store rowId → filename mapping
			// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
			tracking[table.name]![row.id] = filename;
		}
	}

	/**
	 * PHASE 2: Delete orphan files
	 *
	 * Problem: Files can exist on disk with no corresponding Y.js row:
	 * 1. Server crashes between file creation and Y.js persistence
	 * 2. User copy-pastes files in Finder (creates files with new IDs)
	 * 3. Browser extension's refetch deletes Y.js rows but file deletion fails
	 *
	 * Solution: Extract row ID from filename, check if row exists in Y.js.
	 *
	 * Cost: O(n) where n = file count. ~10ms per 100 files (mostly I/O).
	 */
	for (const { table, paired: tableConfig } of tables.$zip(resolvedConfigs)) {
		const filePaths = await listMarkdownFiles(tableConfig.directory);

		for (const filePath of filePaths) {
			const filename = path.basename(filePath);

			// Parse filename to extract row ID and check if row exists in Y.js
			const parsed = tableConfig.parseFilename(filename);
			const rowId = parsed?.id;

			if (!rowId || !table.has(rowId)) {
				// Orphan file: no valid row ID or row doesn't exist in Y.js
				logger.log(
					ProviderError({
						message: `Startup cleanup: deleting orphan file ${table.name}/${filename}`,
						context: { tableName: table.name, filename, filePath },
					}),
				);
				await deleteMarkdownFile({ filePath: filePath as AbsolutePath });
			}
		}
	}

	/**
	 * PHASE 3: Start runtime watchers IMMEDIATELY
	 *
	 * Key insight: YJS observers can start as soon as tracking map is built (Phase 1)
	 * and orphan files are deleted (Phase 2). We don't need to wait for validation.
	 *
	 * This eliminates the startup delay where the provider was blocked during
	 * file validation, causing tabs to not sync until all files were scanned.
	 *
	 * - Y.js observers: When app changes data → write/update/delete markdown files
	 * - File watchers: When user edits files → upsert/delete Y.js rows
	 */
	const unsubscribers = registerYJSObservers();
	const watchers = registerFileWatchers();

	/**
	 * PHASE 4: Validate remaining files (DEFERRED/NON-BLOCKING)
	 *
	 * Problem: Files can be edited externally while server is down.
	 * The diagnostics from last session are stale.
	 *
	 * Solution: Re-validate every file and rebuild diagnostics from scratch.
	 * This runs in the background - the provider is already "ready" for sync.
	 *
	 * Cost: O(n × (read + deserialize)) where n = file count. ~1s per 1000 files.
	 * BUT this no longer blocks startup - syncing begins immediately.
	 */
	void validateAllMarkdownFiles({ operation: 'Initial scan' }).catch((err) => {
		console.error('[MarkdownProvider] Background validation failed:', err);
	});

	return defineProviders({
		async destroy() {
			for (const unsub of unsubscribers) {
				unsub();
			}
			// chokidar's close() is async - wait for all watchers to fully close
			await Promise.all(watchers.map((watcher) => watcher.close()));
			// Flush and close logger to ensure all pending logs are written
			await logger.close();
		},

		/**
		 * Pull: Sync from YJS to Markdown using diff-based synchronization.
		 *
		 * Computes the diff between YJS and markdown files, then applies only the changes:
		 * - Files in markdown but not in YJS → deleted
		 * - Rows in YJS but not in markdown → file created
		 * - Rows in both → file updated only if content differs
		 */
		async pullToMarkdown() {
			return tryAsync({
				try: async () => {
					syncCoordination.yjsWriteCount++;

					await Promise.all(
						tables
							.$zip(resolvedConfigs)
							.map(async ({ table, paired: tableConfig }) => {
								const tableTracking = tracking[table.name];
								const filePaths = await listMarkdownFiles(
									tableConfig.directory,
								);

								const markdownIds = new Map(
									filePaths
										.map((filePath) => {
											const filename = path.basename(filePath);
											const parsed = tableConfig.parseFilename(filename);
											return parsed?.id
												? ([parsed.id, filePath as AbsolutePath] as const)
												: null;
										})
										.filter(
											(entry): entry is [string, AbsolutePath] =>
												entry !== null,
										),
								);

								const yjsRows = table.getAllValid();
								const yjsIds = new Set(yjsRows.map((row) => String(row.id)));

								const idsToDelete = [...markdownIds.entries()].filter(
									([id]) => !yjsIds.has(id),
								);
								await Promise.all(
									idsToDelete.map(async ([id, filePath]) => {
										const { error } = await deleteMarkdownFile({ filePath });
										if (error) {
											logger.log(
												ProviderError({
													message: `pullToMarkdown: failed to delete ${filePath}`,
													context: { filePath, tableName: table.name },
												}),
											);
										}
										if (tableTracking) {
											delete tableTracking[id];
										}
									}),
								);

								await Promise.all(
									yjsRows.map(async (row) => {
										const serializedRow = row.toJSON();
										const { frontmatter, body, filename } =
											tableConfig.serialize({
												row: serializedRow,
												table,
											});

										const filePath = path.join(
											tableConfig.directory,
											filename,
										) as AbsolutePath;

										const existingFilePath = markdownIds.get(String(row.id));
										const isNewFile = !existingFilePath;
										const filenameChanged =
											existingFilePath &&
											path.basename(existingFilePath) !== filename;

										if (filenameChanged && existingFilePath) {
											await deleteMarkdownFile({
												filePath: existingFilePath,
											});
										}

										let shouldWrite = isNewFile || filenameChanged;

										if (!shouldWrite && existingFilePath) {
											const { data: existingContent, error: readError } =
												await readMarkdownFile(existingFilePath);
											if (readError) {
												shouldWrite = true;
											} else {
												const {
													data: existingFrontmatter,
													body: existingBody,
												} = existingContent;
												const frontmatterChanged =
													JSON.stringify(frontmatter) !==
													JSON.stringify(existingFrontmatter);
												const bodyChanged = body !== existingBody;
												shouldWrite = frontmatterChanged || bodyChanged;
											}
										}

										if (shouldWrite) {
											const { error } = await writeMarkdownFile({
												filePath,
												frontmatter,
												body,
											});
											if (error) {
												logger.log(
													ProviderError({
														message: `pullToMarkdown: failed to write ${filePath}`,
														context: {
															filePath,
															tableName: table.name,
															rowId: row.id,
														},
													}),
												);
											}
										}

										if (tableTracking) {
											tableTracking[String(row.id)] = filename;
										}
									}),
								);
							}),
					);

					syncCoordination.yjsWriteCount--;
				},
				catch: (error) => {
					syncCoordination.yjsWriteCount--;
					return ProviderErr({
						message: `Markdown provider pull failed: ${extractErrorMessage(error)}`,
						context: { operation: 'pull' },
					});
				},
			});
		},

		/**
		 * Push: Sync from Markdown to YJS using diff-based synchronization.
		 *
		 * Computes the diff between markdown files and YJS, then applies only the changes:
		 * - Rows in markdown but not in YJS → added
		 * - Rows in YJS but not in markdown → deleted
		 * - Rows in both → updated (no-op if content unchanged)
		 *
		 * **Deletion safety**: A YJS row is only deleted if no file exists with that ID.
		 * If a file exists but fails to read or deserialize, the row is preserved and
		 * a diagnostic is recorded. This prevents data loss when files have temporary
		 * I/O errors or invalid content that the user can fix.
		 *
		 * The distinction:
		 * - Can't parse ID from filename → file is unidentifiable → row deleted (can't protect what we can't identify)
		 * - Can parse ID but can't read/deserialize → file exists → row preserved (user can fix the file)
		 *
		 * All YJS operations are wrapped in a single transaction for atomicity.
		 */
		async pushFromMarkdown() {
			return tryAsync({
				try: async () => {
					syncCoordination.fileChangeCount++;

					diagnostics.clear();

					type TableSyncData = {
						table: TableHelper<TTablesSchema[keyof TTablesSchema]>;
						yjsIds: Set<string>;
						fileExistsIds: Set<string>;
						markdownRows: Map<
							string,
							SerializedRow<TTablesSchema[keyof TTablesSchema & string]>
						>;
						markdownFilenames: Map<string, string>;
					};

					const allTableData = await Promise.all(
						tables
							.$zip(resolvedConfigs)
							.map(
								async ({
									table,
									paired: tableConfig,
								}): Promise<TableSyncData> => {
									const yjsIds = new Set(
										table
											.getAll()
											.map((result) =>
												result.status === 'valid' ? result.row.id : result.id,
											),
									);

									const filePaths = await listMarkdownFiles(
										tableConfig.directory,
									);

									const fileExistsIds = new Set(
										filePaths
											.map(
												(filePath) =>
													tableConfig.parseFilename(path.basename(filePath))
														?.id,
											)
											.filter((id): id is string => Boolean(id)),
									);

									const markdownRows = new Map<
										string,
										SerializedRow<TTablesSchema[keyof TTablesSchema & string]>
									>();
									const markdownFilenames = new Map<string, string>();

									await Promise.all(
										filePaths.map(async (filePath) => {
											const filename = path.basename(filePath);

											const parsed = tableConfig.parseFilename(filename);
											if (!parsed) {
												diagnostics.add({
													filePath,
													tableName: table.name,
													filename,
													error: MarkdownProviderError({
														message: `Failed to parse filename: ${filename}`,
													}),
												});
												logger.log(
													ProviderError({
														message: `pushFromMarkdown: failed to parse filename ${table.name}/${filename}`,
														context: {
															filePath,
															tableName: table.name,
															filename,
														},
													}),
												);
												return;
											}

											const { data: fileContent, error: readError } =
												await readMarkdownFile(filePath);

											if (readError) {
												diagnostics.add({
													filePath,
													tableName: table.name,
													filename,
													error: MarkdownProviderError({
														message: `Failed to read markdown file at ${filePath}: ${readError.message}`,
													}),
												});
												logger.log(
													ProviderError({
														message: `pushFromMarkdown: failed to read ${table.name}/${filename}`,
														context: {
															filePath,
															tableName: table.name,
															filename,
														},
													}),
												);
												return;
											}

											const { data: frontmatter, body } = fileContent;

											const { data: row, error: deserializeError } =
												tableConfig.deserialize({
													frontmatter,
													body,
													filename,
													parsed,
													table,
												});

											if (deserializeError) {
												diagnostics.add({
													filePath,
													tableName: table.name,
													filename,
													error: deserializeError,
												});
												logger.log(
													ProviderError({
														message: `pushFromMarkdown: validation failed for ${table.name}/${filename}`,
														context: {
															filePath,
															tableName: table.name,
															filename,
														},
													}),
												);
												return;
											}

											markdownRows.set(row.id, row);
											markdownFilenames.set(row.id, filename);
										}),
									);

									return {
										table,
										yjsIds,
										fileExistsIds,
										markdownRows,
										markdownFilenames,
									};
								},
							),
					);

					context.ydoc.transact(() => {
						allTableData.forEach(
							({
								table,
								yjsIds,
								fileExistsIds,
								markdownRows,
								markdownFilenames,
							}) => {
								const tableTracking = tracking[table.name];
								const idsToDelete = [...yjsIds].filter(
									(id) => !fileExistsIds.has(id),
								);
								idsToDelete.forEach((id) => {
									table.delete(id);
									if (tableTracking) {
										delete tableTracking[id];
									}
								});

								[...markdownRows.entries()].forEach(([id, row]) => {
									table.upsert(row);
									if (tableTracking) {
										tableTracking[id] = markdownFilenames.get(id) ?? '';
									}
								});
							},
						);
					});

					syncCoordination.fileChangeCount--;
				},
				catch: (error) => {
					syncCoordination.fileChangeCount--;
					return ProviderErr({
						message: `Markdown provider push failed: ${extractErrorMessage(error)}`,
						context: { operation: 'push' },
					});
				},
			});
		},

		/**
		 * Scan all markdown files and rebuild diagnostics
		 *
		 * Validates every markdown file against its schema and updates the diagnostics
		 * to reflect the current state. This is useful for:
		 * - On-demand validation after bulk file edits
		 * - Scheduled validation jobs (e.g., nightly scans)
		 * - Manual verification that diagnostics are accurate
		 *
		 * Note: The initial scan on startup serves the same purpose, but this method
		 * allows re-scanning at any time without restarting the server.
		 */
		async scanForErrors() {
			return tryAsync({
				try: async () => {
					await validateAllMarkdownFiles({ operation: 'scanForErrors' });

					// Return count of errors found
					const errorCount = diagnostics.count();
					console.log(
						`Scan complete: ${errorCount} markdown file${errorCount === 1 ? '' : 's'} with validation errors`,
					);
				},
				catch: (error) => {
					return ProviderErr({
						message: `Markdown provider scan failed: ${extractErrorMessage(error)}`,
						context: { operation: 'scan' },
					});
				},
			});
		},
	});
}) satisfies Provider;
