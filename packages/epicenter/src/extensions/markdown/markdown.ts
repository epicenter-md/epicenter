import { mkdirSync } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync, trySync } from 'wellcrafted/result';
import { defineExports, type ExtensionContext } from '../../dynamic/extension';
import type {
	Field,
	Id,
	KvField,
	Row,
	TableDefinition,
} from '../../dynamic/schema';
import { Id as createId } from '../../dynamic/schema';
import type { TableById } from '../../dynamic/schema/fields/types';
import { getTableById } from '../../dynamic/schema/schema-file';
import type { TableHelper } from '../../dynamic/tables/create-tables';
import { ExtensionErr, ExtensionError } from '../../shared/errors';
import type { AbsolutePath } from '../../shared/types';
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
 * Error types for markdown extension diagnostics
 * Used to track files that fail to process during indexing
 *
 * Context is optional since some errors (like read failures) may not
 * have all the structured data (fileName, id, reason) available.
 */
type MarkdownExtensionContext = {
	fileName: string;
	id: string;
	reason: string;
};

export const { MarkdownExtensionError, MarkdownExtensionErr } =
	createTaggedError('MarkdownExtensionError').withContext<
		MarkdownExtensionContext | undefined
	>();
export type MarkdownExtensionError = ReturnType<typeof MarkdownExtensionError>;

/**
 * Field array type alias for serializer generics.
 * Using readonly array matches the TableDefinition.fields type.
 */
type Fields = readonly Field[];

/**
 * Row type that guarantees an `id` property exists.
 * Row<TFields> alone doesn't guarantee `.id` when TFields is a generic parameter,
 * so we intersect with `{ id: string }` to make destructuring work.
 */
type RowWithId<TFields extends Fields> = Row<TFields> & { id: Id };

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
type TableConfigs<TTableDefinitions extends readonly TableDefinition[]> = {
	[K in TTableDefinitions[number]['id']]?: TableMarkdownConfig<
		TableById<TTableDefinitions, K>['fields']
	>;
};

/**
 * Internal resolved config with all required fields.
 * This is what the provider uses internally after merging user config with defaults.
 */
type ResolvedTableConfig<TFields extends Fields> = {
	directory: AbsolutePath;
	serialize: MarkdownSerializer<TFields>['serialize'];
	parseFilename: MarkdownSerializer<TFields>['deserialize']['parseFilename'];
	deserialize: MarkdownSerializer<TFields>['deserialize']['fromContent'];
};

/**
 * Configuration for the markdown extension.
 *
 * The markdown extension provides bidirectional sync between YJS and markdown files.
 * Files are organized as `{directory}/{tableName}/{filename}.md` by default.
 *
 * @example
 * ```typescript
 * // Basic usage with absolute paths (typically from extension context)
 * markdown(context, {
 *   directory: '/absolute/path/to/workspace',
 *   logsDir: '/absolute/path/to/logs',
 *   diagnosticsPath: '/absolute/path/to/diagnostics.json',
 * })
 *
 * // With custom table configs
 * markdown(context, {
 *   directory: paths.project,
 *   logsDir: path.join(paths.extension, 'logs'),
 *   diagnosticsPath: path.join(paths.extension, 'diagnostics.json'),
 *   tableConfigs: {
 *     posts: {
 *       directory: './blog-posts',  // Relative to workspace directory
 *       serializer: bodyFieldSerializer('content'),
 *     },
 *   },
 * })
 * ```
 */
export type MarkdownExtensionConfig<
	TTableDefinitions extends readonly TableDefinition[],
> = {
	/**
	 * Absolute path to the workspace directory where markdown files are stored.
	 *
	 * Each table's files will be stored in a subdirectory of this path:
	 * `{directory}/{tableName}/` (unless the table config specifies a custom directory).
	 *
	 * @example
	 * ```typescript
	 * // Typical usage: use paths from extension context
	 * directory: paths.project  // e.g., '/Users/me/projects/blog'
	 *
	 * // Files stored at:
	 * // /Users/me/projects/blog/posts/abc123.md
	 * // /Users/me/projects/blog/authors/john-doe.md
	 * ```
	 */
	directory: string;

	/**
	 * Absolute path to the logs directory.
	 *
	 * Error logs are written to `{logsDir}/{workspaceId}.log` as an append-only
	 * historical record of sync errors, validation failures, and other issues.
	 *
	 * @example
	 * ```typescript
	 * logsDir: path.join(paths.extension, 'logs')
	 * // Creates: .epicenter/extensions/markdown/logs/blog.log
	 * ```
	 */
	logsDir: string;

	/**
	 * Absolute path to the diagnostics JSON file.
	 *
	 * Diagnostics track the current state of files with validation errors.
	 * Unlike logs (append-only history), diagnostics are updated in real-time
	 * and files are removed when errors are fixed.
	 *
	 * @example
	 * ```typescript
	 * diagnosticsPath: path.join(paths.extension, 'diagnostics.json')
	 * // Creates: .epicenter/extensions/markdown/diagnostics.json
	 * ```
	 */
	diagnosticsPath: string;

	/**
	 * Per-table markdown configuration.
	 *
	 * Each table can have custom settings for:
	 * - `directory`: WHERE files go (defaults to table name, resolved relative to workspace directory)
	 * - `serializer`: HOW rows are encoded/decoded (defaults to all-frontmatter with `{id}.md` filename)
	 *
	 * Use serializer factories like `bodyFieldSerializer()` or `titleFilenameSerializer()` for common patterns.
	 *
	 * @example
	 * ```typescript
	 * tableConfigs: {
	 *   // Use defaults (empty object)
	 *   settings: {},
	 *
	 *   // Custom directory only
	 *   config: { directory: './app-config' },
	 *
	 *   // Custom serializer: put 'content' field in markdown body
	 *   posts: { serializer: bodyFieldSerializer('content') },
	 *
	 *   // Custom serializer: human-readable filenames like 'my-post-title-abc123.md'
	 *   articles: { serializer: titleFilenameSerializer('title') },
	 *
	 *   // Both custom directory and serializer
	 *   drafts: {
	 *     directory: './drafts',
	 *     serializer: bodyFieldSerializer('content'),
	 *   },
	 * }
	 * ```
	 */
	tableConfigs?: TableConfigs<TTableDefinitions>;

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

export const markdown = async <
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(
	context: ExtensionContext<TTableDefinitions, TKvFields>,
	config: MarkdownExtensionConfig<TTableDefinitions>,
) => {
	const { id, tables, ydoc } = context;
	const {
		directory,
		logsDir,
		diagnosticsPath,
		tableConfigs,
		debug = false,
	} = config;

	const dbg = debug
		? (tag: string, msg: string, data?: Record<string, unknown>) => {
				const timestamp = new Date().toISOString().slice(11, 23);
				console.log(`[MD:${tag}] ${timestamp} ${msg}`, data ?? '');
			}
		: () => {};

	const userTableConfigs: TableConfigs<TTableDefinitions> = tableConfigs ?? {};

	mkdirSync(logsDir, { recursive: true });

	const diagnostics = await createDiagnosticsManager({ diagnosticsPath });
	const logger = createIndexLogger({
		logPath: path.join(logsDir, `${id}.log`),
	});

	const absoluteWorkspaceDir = directory as AbsolutePath;

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
	 * Resolve user table configs into internal format
	 *
	 * User configs use the Serializer interface (composable serialize/deserialize functions).
	 *
	 * We resolve these to a flat internal structure for efficient runtime access.
	 */
	// Cast is correct: Object.fromEntries loses key specificity (returns { [k: string]: V }),
	// but we know keys are exactly table IDs since we iterate tables.definitions.
	const resolvedConfigs: Record<
		string,
		ResolvedTableConfig<TTableDefinitions[number]['fields']>
	> = Object.fromEntries(
		tables.definitions.map((tableDefinition) => {
			const tableName = tableDefinition.id;
			const userConfig =
				(
					userTableConfigs as Record<
						string,
						TableMarkdownConfig<Fields> | undefined
					>
				)[tableName] ?? {};

			// Resolve serializer: user-provided or default
			const serializer = userConfig.serializer ?? defaultSerializer();

			// Resolve directory: user-provided or table name
			const directory = path.resolve(
				absoluteWorkspaceDir,
				userConfig.directory ?? tableName,
			) as AbsolutePath;

			// Flatten for internal use
			const config: ResolvedTableConfig<TTableDefinitions[number]['fields']> = {
				directory,
				serialize: serializer.serialize,
				parseFilename: serializer.deserialize.parseFilename,
				deserialize: serializer.deserialize.fromContent,
			};

			return [tableName, config];
		}),
	);

	/**
	 * Register YJS observers to sync changes from YJS to markdown files
	 *
	 * When rows are added/updated/deleted in YJS, this writes the changes to corresponding
	 * markdown files on disk. Coordinates with the file watcher through shared state to
	 * prevent infinite sync loops.
	 */
	const registerYJSObservers = () => {
		const unsubscribers: Array<() => void> = [];

		for (const [tableName, tableConfig] of Object.entries(resolvedConfigs)) {
			const table = tables.get(tableName);
			const tableDefinition = getTableById(tables.definitions, tableName);
			const fields = tableDefinition!.fields;
			// Initialize tracking map for this table
			if (!tracking[tableName]) {
				tracking[tableName] = {};
			}

			/**
			 * Write a YJS row to markdown file
			 */
			async function writeRowToMarkdown<TFields extends Fields>(
				row: RowWithId<TFields>,
			) {
				const { frontmatter, body, filename } = tableConfig.serialize({
					row,
					fields,
				});

				// Construct file path
				const filePath = path.join(
					tableConfig.directory,
					filename,
				) as AbsolutePath;

				// Check if we need to clean up an old file before updating tracking
				const oldFilename = tracking[tableName]?.[row.id];

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
				tracking[tableName]![row.id] = filename;

				return writeMarkdownFile({
					filePath,
					frontmatter,
					body,
				});
			}

			const unsub = table.observe((changedIds) => {
				if (syncCoordination.fileChangeCount > 0) return;

				for (const id of changedIds) {
					// Fetch the row data to determine if it was added/updated or deleted
					const result = table.get(id);

					if (result.status === 'not_found') {
						// Row was deleted
						void (async () => {
							syncCoordination.yjsWriteCount++;

							const filename = tracking[tableName]?.[id];
							if (filename) {
								const filePath = path.join(
									tableConfig.directory,
									filename,
								) as AbsolutePath;
								const { error } = await deleteMarkdownFile({ filePath });

								// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
								delete tracking[tableName]![id];

								if (error) {
									logger.log(
										ExtensionError({
											message: `YJS observer onDelete: failed to delete ${tableName}/${id}`,
											context: {
												tableName,
												rowId: id,
												filePath,
											},
										}),
									);
								}
							}

							syncCoordination.yjsWriteCount--;
						})();
						continue;
					}

					if (result.status === 'invalid') {
						const errorMessages = result.errors
							.map(
								(e) => `${(e as { path?: string }).path ?? ''}: ${e.message}`,
							)
							.join(', ');
						logger.log(
							ExtensionError({
								message: `YJS observer: validation failed for ${tableName}/${id}: ${errorMessages}`,
								context: {
									tableName,
									rowId: id,
								},
							}),
						);
						continue;
					}

					// Row was added or updated
					const row = result.row;
					void (async () => {
						syncCoordination.yjsWriteCount++;
						const { error } = await writeRowToMarkdown(row);
						syncCoordination.yjsWriteCount--;

						if (error) {
							logger.log(
								ExtensionError({
									message: `YJS observer: failed to write ${tableName}/${row.id}`,
									context: { tableName, rowId: row.id },
								}),
							);
						}
					})();
				}
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

		for (const [tableName, tableConfig] of Object.entries(resolvedConfigs)) {
			const table = tables.get(tableName);
			const tableDefinition = getTableById(tables.definitions, tableName);
			const fields = tableDefinition!.fields;
			// Ensure table directory exists
			const { error: mkdirError } = trySync({
				try: () => {
					mkdirSync(tableConfig.directory, { recursive: true });
				},
				catch: (error) =>
					ExtensionErr({
						message: `Failed to create table directory: ${extractErrorMessage(error)}`,
						context: {
							tableName,
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
				dbg('HANDLER', `START ${tableName}/${filename}`, {
					yjsWriteCount: syncCoordination.yjsWriteCount,
					fileChangeCount: syncCoordination.fileChangeCount,
				});

				// Skip if this file change was triggered by a YJS change
				if (syncCoordination.yjsWriteCount > 0) {
					dbg('HANDLER', `SKIP ${tableName}/${filename} (yjsWriteCount > 0)`);
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
						dbg('HANDLER', `FAIL ${tableName}/${filename} (read error)`, {
							error: readError.message,
						});
						diagnostics.add({
							filePath: absolutePath,
							tableName,
							filename,
							error: MarkdownExtensionError({
								message: `Failed to read markdown file at ${absolutePath}: ${readError.message}`,
							}),
						});
						logger.log(
							ExtensionError({
								message: `File watcher: failed to read ${tableName}/${filename}`,
								context: {
									filePath: absolutePath,
									tableName,
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
						dbg('HANDLER', `FAIL ${tableName}/${filename} (parse error)`);
						const error = MarkdownExtensionError({
							message: `Failed to parse filename: ${filename}`,
						});
						diagnostics.add({
							filePath: absolutePath,
							tableName,
							filename,
							error,
						});
						logger.log(
							ExtensionError({
								message: `File watcher: failed to parse filename ${tableName}/${filename}`,
								context: {
									filePath: absolutePath,
									tableName,
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
							fields,
						});

					if (deserializeError) {
						dbg('HANDLER', `FAIL ${tableName}/${filename} (validation error)`, {
							error: deserializeError.message,
						});
						diagnostics.add({
							filePath: absolutePath,
							tableName,
							filename,
							error: deserializeError,
						});
						logger.log(
							ExtensionError({
								message: `File watcher: validation failed for ${tableName}/${filename}`,
								context: {
									filePath: absolutePath,
									tableName,
									filename,
								},
							}),
						);
						return;
					}

					// Convert id from string to branded Id type
					const validatedRow = {
						...row,
						id: createId((row as { id: string }).id),
					} as RowWithId<TTableDefinitions[number]['fields']>;

					// Success: remove from diagnostics if it was previously invalid
					diagnostics.remove({ filePath: absolutePath });

					// Check for duplicate files: same row ID but different filename
					// This happens when users copy-paste markdown files in Finder
					const existingFilename = tracking[tableName]?.[validatedRow.id];

					if (existingFilename && existingFilename !== filename) {
						// This is a duplicate file with the same ID - delete it
						dbg(
							'HANDLER',
							`SKIP ${tableName}/${filename} (duplicate of ${existingFilename})`,
							{
								rowId: validatedRow.id,
							},
						);
						logger.log(
							ExtensionError({
								message: `Duplicate file detected: ${filename} has same ID as ${existingFilename}, deleting duplicate`,
								context: {
									tableName,
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
					tracking[tableName]![validatedRow.id] = filename;
					table.upsert(validatedRow);
					dbg('HANDLER', `SUCCESS ${tableName}/${filename}`, {
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
					dbg('HANDLER', `UNLINK ${tableName}/${filename}`, {
						extractedRowId: rowIdToDelete ?? 'undefined',
					});

					if (rowIdToDelete) {
						const brandedRowId = createId(rowIdToDelete);
						if (table.has(brandedRowId)) {
							table.delete(brandedRowId);
							dbg(
								'HANDLER',
								`UNLINK deleted row ${tableName}/${rowIdToDelete}`,
							);
						} else {
							dbg(
								'HANDLER',
								`UNLINK row not in Y.js ${tableName}/${rowIdToDelete}`,
							);
						}

						// Clean up tracking (if it existed)
						// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
						delete tracking[tableName]![rowIdToDelete];
					} else {
						logger.log(
							ExtensionError({
								message: `File deleted but could not parse row ID from ${tableName}/${filename}`,
								context: { tableName, filename },
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
					dbg('CHOKIDAR', `add: ${tableName}/${path.basename(filePath)}`);
					handleFileAddOrChange(filePath);
				})
				.on('change', (filePath) => {
					dbg('CHOKIDAR', `change: ${tableName}/${path.basename(filePath)}`);
					handleFileAddOrChange(filePath);
				})
				.on('unlink', (filePath) => {
					dbg('CHOKIDAR', `unlink: ${tableName}/${path.basename(filePath)}`);
					handleFileUnlink(filePath);
				})
				.on('error', (error) => {
					dbg('CHOKIDAR', `error: ${tableName}`, {
						error: extractErrorMessage(error),
					});
					logger.log(
						ExtensionError({
							message: `File watcher error for ${tableName}: ${extractErrorMessage(error)}`,
							context: {
								tableName,
								directory: tableConfig.directory,
							},
						}),
					);
				})
				.on('ready', () => {
					dbg(
						'CHOKIDAR',
						`ready: ${tableName} watching ${tableConfig.directory}`,
					);
				});

			watchers.push(watcher);
		}

		return watchers;
	};

	/**
	 * Validate all markdown files and rebuild diagnostics
	 *
	 * Scans every markdown file, validates it against the table definition, and updates diagnostics
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

		for (const [tableName, tableConfig] of Object.entries(resolvedConfigs)) {
			const tableDefinition = getTableById(tables.definitions, tableName);
			const fields = tableDefinition!.fields;
			const filePaths = await listMarkdownFiles(tableConfig.directory);

			await Promise.all(
				filePaths.map(async (filePath) => {
					const filename = path.basename(filePath);

					const { data: fileContent, error: readError } =
						await readMarkdownFile(filePath);

					if (readError) {
						diagnostics.add({
							filePath,
							tableName,
							filename,
							error: MarkdownExtensionError({
								message: `Failed to read markdown file at ${filePath}: ${readError.message}`,
							}),
						});
						logger.log(
							ExtensionError({
								message: `${operationPrefix}failed to read ${tableName}/${filename}`,
								context: { filePath, tableName, filename },
							}),
						);
						return;
					}

					const { data: frontmatter, body } = fileContent;

					// Parse filename to extract structured data
					const parsed = tableConfig.parseFilename(filename);
					if (!parsed) {
						const error = MarkdownExtensionError({
							message: `Failed to parse filename: ${filename}`,
						});
						diagnostics.add({
							filePath,
							tableName,
							filename,
							error,
						});
						logger.log(
							ExtensionError({
								message: `${operationPrefix}failed to parse filename ${tableName}/${filename}`,
								context: { filePath, tableName, filename },
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
						fields,
					});

					if (deserializeError) {
						// Track validation error in diagnostics (current state)
						diagnostics.add({
							filePath,
							tableName,
							filename,
							error: deserializeError,
						});
						// Log to historical record
						logger.log(
							ExtensionError({
								message: `${operationPrefix}validation failed for ${tableName}/${filename}`,
								context: { filePath, tableName, filename },
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
	// │   For each remaining file, deserialize and validate against definition.  │
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
	for (const [tableName, tableConfig] of Object.entries(resolvedConfigs)) {
		const table = tables.get(tableName);
		const tableDefinition = getTableById(tables.definitions, tableName);
		const fields = tableDefinition!.fields;
		// Initialize tracking map for this table
		if (!tracking[tableName]) {
			tracking[tableName] = {};
		}

		// Get all valid rows from YJS
		const rows = table.getAllValid();

		// Serialize each row to extract filename and populate tracking (rowId → filename)
		for (const row of rows) {
			const { filename } = tableConfig.serialize({
				row,
				fields,
			});

			// Store rowId → filename mapping
			// biome-ignore lint/style/noNonNullAssertion: tracking is initialized at loop start for each table
			tracking[tableName]![row.id] = filename;
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
	for (const [tableName, tableConfig] of Object.entries(resolvedConfigs)) {
		const table = tables.get(tableName);
		const filePaths = await listMarkdownFiles(tableConfig.directory);

		for (const filePath of filePaths) {
			const filename = path.basename(filePath);

			// Parse filename to extract row ID and check if row exists in Y.js
			const parsed = tableConfig.parseFilename(filename);
			const rowId = parsed?.id ? createId(parsed.id) : undefined;

			if (!rowId || !table.has(rowId)) {
				// Orphan file: no valid row ID or row doesn't exist in Y.js
				logger.log(
					ExtensionError({
						message: `Startup cleanup: deleting orphan file ${tableName}/${filename}`,
						context: { tableName, filename, filePath },
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

	return defineExports({
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
						Object.entries(resolvedConfigs).map(
							async ([tableName, tableConfig]) => {
								const table = tables.get(tableName);
								const tableDefinition = getTableById(
									tables.definitions,
									tableName,
								);
								const fields = tableDefinition!.fields;
								const tableTracking = tracking[tableName];
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
												ExtensionError({
													message: `pullToMarkdown: failed to delete ${filePath}`,
													context: { filePath, tableName },
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
										const { frontmatter, body, filename } =
											tableConfig.serialize({
												row,
												fields,
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
													ExtensionError({
														message: `pullToMarkdown: failed to write ${filePath}`,
														context: {
															filePath,
															tableName,
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
							},
						),
					);

					syncCoordination.yjsWriteCount--;
				},
				catch: (error) => {
					syncCoordination.yjsWriteCount--;
					return ExtensionErr({
						message: `Markdown extension pull failed: ${extractErrorMessage(error)}`,
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
						tableName: string;
						table: TableHelper<string, TTableDefinitions[number]['fields']>;
						yjsIds: Set<Id>;
						fileExistsIds: Set<Id>;
						markdownRows: Map<
							Id,
							RowWithId<TTableDefinitions[number]['fields']>
						>;
						markdownFilenames: Map<Id, string>;
					};

					const allTableData = await Promise.all(
						Object.entries(resolvedConfigs).map(
							async ([tableName, tableConfig]): Promise<TableSyncData> => {
								const table = tables.get(tableName);
								const tableDefinition = getTableById(
									tables.definitions,
									tableName,
								);
								const fields = tableDefinition!.fields;
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
										.map((filePath) => {
											const parsed = tableConfig.parseFilename(
												path.basename(filePath),
											);
											return parsed?.id ? createId(parsed.id) : undefined;
										})
										.filter((id): id is Id => Boolean(id)),
								);

								const markdownRows = new Map<
									Id,
									RowWithId<TTableDefinitions[number]['fields']>
								>();
								const markdownFilenames = new Map<Id, string>();

								await Promise.all(
									filePaths.map(async (filePath) => {
										const filename = path.basename(filePath);

										const parsed = tableConfig.parseFilename(filename);
										if (!parsed) {
											diagnostics.add({
												filePath,
												tableName,
												filename,
												error: MarkdownExtensionError({
													message: `Failed to parse filename: ${filename}`,
												}),
											});
											logger.log(
												ExtensionError({
													message: `pushFromMarkdown: failed to parse filename ${tableName}/${filename}`,
													context: {
														filePath,
														tableName,
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
												tableName,
												filename,
												error: MarkdownExtensionError({
													message: `Failed to read markdown file at ${filePath}: ${readError.message}`,
												}),
											});
											logger.log(
												ExtensionError({
													message: `pushFromMarkdown: failed to read ${tableName}/${filename}`,
													context: {
														filePath,
														tableName,
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
												fields,
											});

										if (deserializeError) {
											diagnostics.add({
												filePath,
												tableName,
												filename,
												error: deserializeError,
											});
											logger.log(
												ExtensionError({
													message: `pushFromMarkdown: validation failed for ${tableName}/${filename}`,
													context: {
														filePath,
														tableName,
														filename,
													},
												}),
											);
											return;
										}

										// Convert row.id from string to branded Id
										const rowWithBrandedId = {
											...row,
											id: createId((row as { id: string }).id),
										} as RowWithId<TTableDefinitions[number]['fields']>;
										markdownRows.set(rowWithBrandedId.id, rowWithBrandedId);
										markdownFilenames.set(rowWithBrandedId.id, filename);
									}),
								);

								return {
									tableName,
									table,
									yjsIds,
									fileExistsIds,
									markdownRows,
									markdownFilenames,
								};
							},
						),
					);

					ydoc.transact(() => {
						allTableData.forEach(
							({
								tableName,
								table,
								yjsIds,
								fileExistsIds,
								markdownRows,
								markdownFilenames,
							}) => {
								const tableTracking = tracking[tableName];
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
					return ExtensionErr({
						message: `Markdown extension push failed: ${extractErrorMessage(error)}`,
						context: { operation: 'push' },
					});
				},
			});
		},

		/**
		 * Scan all markdown files and rebuild diagnostics
		 *
		 * Validates every markdown file against its table definition and updates the diagnostics
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
					return ExtensionErr({
						message: `Markdown extension scan failed: ${extractErrorMessage(error)}`,
						context: { operation: 'scan' },
					});
				},
			});
		},
	});
};
