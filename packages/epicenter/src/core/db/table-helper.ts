import { type ArkErrors, type } from 'arktype';
import { createTaggedError, type TaggedError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import * as Y from 'yjs';
import { defineMutation, defineQuery } from '../actions';
import type {
	CellValue,
	Row,
	SerializedRow,
	TableSchema,
	TableValidators,
	WorkspaceSchema,
	WorkspaceValidators,
} from '../schema';
import { serializeCellValue } from '../schema';
import { updateYRowFromSerializedRow } from '../utils/yjs';

/**
 * Error thrown when attempting to insert a row with an ID that already exists
 */
export const { RowAlreadyExistsError, RowAlreadyExistsErr } = createTaggedError(
	'RowAlreadyExistsError',
);
export type RowAlreadyExistsError = ReturnType<typeof RowAlreadyExistsError>;

/**
 * Error thrown when attempting to update or access a row that doesn't exist
 */
export const { RowNotFoundError, RowNotFoundErr } =
	createTaggedError('RowNotFoundError');
export type RowNotFoundError = ReturnType<typeof RowNotFoundError>;

/**
 * Context for row validation errors
 */
type RowValidationContext = {
	tableName: string;
	id: string;
	errors: ArkErrors;
	summary: string;
};

/**
 * Error thrown when a row fails schema validation
 */
export const { RowValidationError, RowValidationErr } = createTaggedError<
	'RowValidationError',
	RowValidationContext
>('RowValidationError');

export type RowValidationError = TaggedError<
	'RowValidationError',
	RowValidationContext
>;

/**
 * YJS representation of a row
 * Maps column names to YJS shared types or primitives
 */
export type YRow = Y.Map<CellValue>;

/**
 * Creates a type-safe collection of table helpers for all tables in a schema.
 *
 * This function maps over the table schemas and creates a TableHelper for each table,
 * returning an object where each key is a table name and each value is the corresponding
 * typed helper with full CRUD operations.
 *
 * @param ydoc - The YJS document instance
 * @param schema - Raw table schemas (column definitions only)
 * @param validators - Table validators (validation methods)
 * @param ytables - The root YJS Map containing all table data
 * @returns Object mapping table names to their typed TableHelper instances
 */
export function createTableHelpers<TWorkspaceSchema extends WorkspaceSchema>({
	ydoc,
	schema,
	validators,
	ytables,
}: {
	ydoc: Y.Doc;
	schema: TWorkspaceSchema;
	validators: WorkspaceValidators<TWorkspaceSchema>;
	ytables: Y.Map<Y.Map<YRow>>;
}) {
	return Object.fromEntries(
		Object.entries(schema).map(([tableName, tableSchema]) => {
			const ytable = ytables.get(tableName);
			if (!ytable) {
				throw new Error(`Table "${tableName}" not found in YJS document`);
			}
			return [
				tableName,
				createTableHelper({
					ydoc,
					tableName,
					ytable,
					schema: tableSchema,
					// biome-ignore lint/style/noNonNullAssertion: validators is created by createWorkspaceValidators which maps over the same schema object, so every key in schema has a corresponding key in validators
					validators: validators[tableName]!,
				}),
			];
		}),
	) as {
		[TTableName in keyof TWorkspaceSchema]: TableHelper<
			TWorkspaceSchema[TTableName]
		>;
	};
}

/**
 * Creates a single table helper with type-safe CRUD operations for a specific table.
 *
 * This is a pure function that wraps a YJS Map (representing a table) with methods
 * for inserting, updating, deleting, and querying rows. All operations are properly
 * typed based on the table's row type.
 *
 * @param ydoc - The YJS document instance (used for transactions)
 * @param tableName - Name of the table (used in error messages)
 * @param ytable - The YJS Map containing the table's row data
 * @param schema - The table schema (column definitions only)
 * @param validators - The table validators (validation methods)
 * @returns A TableHelper instance with full CRUD operations
 */
function createTableHelper<TTableSchema extends TableSchema>({
	ydoc,
	tableName,
	ytable,
	schema,
	validators,
}: {
	ydoc: Y.Doc;
	tableName: string;
	ytable: Y.Map<YRow>;
	schema: TTableSchema;
	validators: TableValidators<TTableSchema>;
}) {
	type TRow = Row<TTableSchema>;

	return {
		/**
		 * The name of this table
		 */
		name: tableName,

		/**
		 * The schema definition for this table (column definitions)
		 */
		schema,

		/**
		 * The validators for this table (runtime validation methods)
		 */
		validators,

		/**
		 * Insert a new row into the table.
		 *
		 * For Y.js columns (ytext, tags), provide plain JavaScript values:
		 * - ytext columns accept strings
		 * - tags columns accept arrays
		 *
		 * Internally, strings are synced to Y.Text using updateYTextFromString(),
		 * and arrays are synced to Y.Array using updateYArrayFromArray().
		 */
		insert: defineMutation({
			input: validators.toStandardSchema(),
			description: `Insert a new row into the ${tableName} table`,
			handler: (serializedRow) => {
				if (ytable.has(serializedRow.id)) {
					return RowAlreadyExistsErr({
						message: `Row with id "${serializedRow.id}" already exists in table "${tableName}"`,
						context: { tableName, operation: 'insert', id: serializedRow.id },
					});
				}

				ydoc.transact(() => {
					const yrow = new Y.Map<CellValue>();
					updateYRowFromSerializedRow({ yrow, serializedRow, schema });
					ytable.set(serializedRow.id, yrow);
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Update specific fields of an existing row.
		 *
		 * For Y.js columns (ytext, tags), provide plain JavaScript values:
		 * - ytext columns accept strings
		 * - tags columns accept arrays
		 *
		 * Internally, the existing Y.Text/Y.Array is synced using updateYTextFromString()
		 * or updateYArrayFromArray() to apply minimal changes while preserving CRDT history.
		 *
		 * Only the fields you include will be updated - others remain unchanged.
		 */
		update: defineMutation({
			input: validators.toPartialStandardSchema(),
			description: `Update specific fields of an existing row in the ${tableName} table`,
			handler: (partialSerializedRow) => {
				const yrow = ytable.get(partialSerializedRow.id);
				if (!yrow) {
					return RowNotFoundErr({
						message: `Row with id "${partialSerializedRow.id}" not found in table "${tableName}"`,
						context: {
							tableName,
							operation: 'update',
							id: partialSerializedRow.id,
						},
					});
				}

				ydoc.transact(() => {
					updateYRowFromSerializedRow({
						yrow,
						serializedRow: partialSerializedRow,
						schema,
					});
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Insert or update a row (insert if doesn't exist, update if exists).
		 *
		 * For Y.js columns (ytext, tags), provide plain JavaScript values.
		 * Internally syncs using updateYTextFromString() and updateYArrayFromArray().
		 */
		upsert: defineMutation({
			input: validators.toStandardSchema(),
			description: `Insert or update a row in the ${tableName} table`,
			handler: (serializedRow) => {
				ydoc.transact(() => {
					let yrow = ytable.get(serializedRow.id);
					if (!yrow) {
						yrow = new Y.Map<CellValue>();
						ytable.set(serializedRow.id, yrow);
					}
					updateYRowFromSerializedRow({ yrow, serializedRow, schema });
				});
			},
		}),

		/** Insert multiple rows into the table */
		insertMany: defineMutation({
			input: validators.toStandardSchemaArray(),
			description: `Insert multiple rows into the ${tableName} table`,
			handler: ({ rows }) => {
				// Check for duplicates first
				for (const serializedRow of rows) {
					if (ytable.has(serializedRow.id)) {
						return RowAlreadyExistsErr({
							message: `Row with id "${serializedRow.id}" already exists in table "${tableName}"`,
							context: {
								tableName,
								operation: 'insertMany',
								id: serializedRow.id,
							},
						});
					}
				}

				ydoc.transact(() => {
					for (const serializedRow of rows) {
						const yrow = new Y.Map<CellValue>();
						updateYRowFromSerializedRow({ yrow, serializedRow, schema });
						ytable.set(serializedRow.id, yrow);
					}
				});

				return Ok(undefined);
			},
		}),

		/** Insert or update multiple rows */
		upsertMany: defineMutation({
			input: validators.toStandardSchemaArray(),
			description: `Insert or update multiple rows in the ${tableName} table`,
			handler: ({ rows }) => {
				ydoc.transact(() => {
					for (const serializedRow of rows) {
						let yrow = ytable.get(serializedRow.id);
						if (!yrow) {
							yrow = new Y.Map<CellValue>();
							ytable.set(serializedRow.id, yrow);
						}
						updateYRowFromSerializedRow({ yrow, serializedRow, schema });
					}
				});
			},
		}),

		/** Update multiple rows */
		updateMany: defineMutation({
			input: validators.toPartialStandardSchemaArray(),
			description: `Update multiple rows in the ${tableName} table`,
			handler: ({ rows }) => {
				// Check all rows exist first
				for (const partialSerializedRow of rows) {
					if (!ytable.has(partialSerializedRow.id)) {
						return RowNotFoundErr({
							message: `Row with id "${partialSerializedRow.id}" not found in table "${tableName}"`,
							context: {
								tableName,
								operation: 'updateMany',
								id: partialSerializedRow.id,
							},
						});
					}
				}

				ydoc.transact(() => {
					for (const partialSerializedRow of rows) {
						// Safe to assert non-null because we checked all IDs exist above
						const yrow = ytable.get(partialSerializedRow.id);
						if (!yrow) continue; // Skip if somehow missing (defensive)
						updateYRowFromSerializedRow({
							yrow,
							serializedRow: partialSerializedRow,
							schema,
						});
					}
				});

				return Ok(undefined);
			},
		}),

		/**
		 * Get a row by ID, returning Y.js objects for collaborative editing.
		 *
		 * @returns
		 * - `null` if row doesn't exist
		 * - `Ok(row)` if row exists and is valid
		 * - `Err(RowValidationError)` if row exists but fails validation
		 */
		get: defineQuery({
			input: type({
				id: 'string',
			}),
			description: `Get a row by ID from the ${tableName} table`,
			handler: (params): Result<TRow, RowValidationError> | null => {
				const yrow = ytable.get(params.id);
				if (!yrow) {
					return null;
				}

				const row = buildRowFromYRow(yrow, schema);
				const yjsValidator = validators.toYjsArktype();
				const result = yjsValidator(row);

				if (result instanceof type.errors) {
					return RowValidationErr({
						message: `Row '${params.id}' in table '${tableName}' failed validation`,
						context: {
							tableName,
							id: params.id,
							errors: result,
							summary: result.summary,
						},
					});
				}

				return Ok(row);
			},
		}),

		/**
		 * Get all valid rows with Y.js objects for collaborative editing.
		 * Rows that fail validation are skipped.
		 * Use `getAllInvalid()` to get validation errors for invalid rows.
		 */
		getAll: defineQuery({
			description: `Get all valid rows from the ${tableName} table`,
			handler: (): TRow[] => {
				const validRows: TRow[] = [];
				const yjsValidator = validators.toYjsArktype();

				for (const yrow of ytable.values()) {
					const row = buildRowFromYRow(yrow, schema);
					const result = yjsValidator(row);

					if (!(result instanceof type.errors)) {
						validRows.push(row);
					}
				}

				return validRows;
			},
		}),

		/**
		 * Get validation errors for all invalid rows.
		 * Returns an array of RowValidationError objects for rows that fail validation.
		 * Valid rows are skipped.
		 */
		getAllInvalid: defineQuery({
			description: `Get validation errors for invalid rows in the ${tableName} table`,
			handler: (): RowValidationError[] => {
				const errors: RowValidationError[] = [];
				const yjsValidator = validators.toYjsArktype();

				for (const [id, yrow] of ytable.entries()) {
					const row = buildRowFromYRow(yrow, schema);
					const result = yjsValidator(row);

					if (result instanceof type.errors) {
						errors.push(
							RowValidationError({
								message: `Row '${id}' in table '${tableName}' failed validation`,
								context: {
									tableName,
									id,
									errors: result,
									summary: result.summary,
								},
							}),
						);
					}
				}

				return errors;
			},
		}),

		/** Check if a row exists by ID */
		has: defineQuery({
			input: type({ id: 'string' }),
			description: `Check if a row exists in the ${tableName} table`,
			handler: (params) => ytable.has(params.id),
		}),

		/** Delete a row by ID */
		delete: defineMutation({
			input: type({ id: 'string' }),
			description: `Delete a row from the ${tableName} table`,
			handler: (params) => {
				ydoc.transact(() => {
					ytable.delete(params.id);
				});
			},
		}),

		/** Delete multiple rows by IDs */
		deleteMany: defineMutation({
			input: type({ ids: 'string[]' }),
			description: `Delete multiple rows from the ${tableName} table`,
			handler: (params) => {
				ydoc.transact(() => {
					for (const id of params.ids) {
						ytable.delete(id);
					}
				});
			},
		}),

		/** Clear all rows from the table */
		clear: defineMutation({
			description: `Clear all rows from the ${tableName} table`,
			handler: () => {
				ydoc.transact(() => {
					ytable.clear();
				});
			},
		}),

		/** Get the total number of rows in the table */
		count: defineQuery({
			description: `Count rows in the ${tableName} table`,
			handler: () => ytable.size,
		}),

		/**
		 * Filter rows by predicate, returning only valid rows that match.
		 * Invalid rows are skipped (not validated against predicate).
		 *
		 * @param predicate Function that returns true for rows to include
		 * @returns Array of valid rows that match the predicate
		 */
		filter(predicate: (row: TRow) => boolean): TRow[] {
			const results: TRow[] = [];
			const yjsValidator = validators.toYjsArktype();

			for (const yrow of ytable.values()) {
				const row = buildRowFromYRow(yrow, schema);
				const result = yjsValidator(row);

				// Only include valid rows - skip schema-mismatch
				if (!(result instanceof type.errors)) {
					if (predicate(row)) {
						results.push(row);
					}
				}
			}

			return results;
		},

		/**
		 * Find the first row that matches the predicate.
		 * Invalid rows are skipped (not validated against predicate).
		 *
		 * @param predicate Function that returns true for the row to find
		 * @returns The first matching valid row, or `null` if no match found
		 */
		find(predicate: (row: TRow) => boolean): TRow | null {
			const yjsValidator = validators.toYjsArktype();

			for (const yrow of ytable.values()) {
				const row = buildRowFromYRow(yrow, schema);
				const result = yjsValidator(row);

				// Only check predicate on valid rows - skip schema-mismatch
				if (!(result instanceof type.errors)) {
					if (predicate(row)) {
						return row;
					}
				}
			}

			// No match found
			return null;
		},

		/**
		 * Watch for changes to the table and get notified when rows are added, updated, or deleted.
		 *
		 * This is your reactive hook into the table. Whenever someone (local or remote) adds a row,
		 * modifies any field in a row, or deletes a row, you'll receive a callback with the relevant
		 * data. Perfect for keeping UI in sync with database state.
		 *
		 * @example
		 * const unsubscribe = table.observe({
		 *   onAdd: (result) => {
		 *     if (result.error) {
		 *       console.error('Invalid row:', result.error);
		 *       return;
		 *     }
		 *     console.log('New row:', result.data);
		 *   },
		 *   onUpdate: (result) => {
		 *     if (result.error) {
		 *       console.error('Invalid row:', result.error);
		 *       return;
		 *     }
		 *     console.log('Row changed:', result.data);
		 *   },
		 *   onDelete: (id) => console.log('Row removed:', id),
		 * });
		 *
		 * // Later, stop watching
		 * unsubscribe();
		 *
		 * ## How it works under the hood
		 *
		 * Tables are stored as a **Y.Map of Y.Maps** structure:
		 * ```
		 * ytable (Y.Map)
		 * ├── "row-1" → Y.Map { title: "Hello", count: 5 }
		 * ├── "row-2" → Y.Map { title: "World", count: 10 }
		 * └── "row-3" → Y.Map { title: "!", count: 1 }
		 * ```
		 *
		 * We use Y.js's `observeDeep()` to watch this nested structure. This gives us events at
		 * two different levels:
		 *
		 * 1. **Changes to the table itself** (adding/removing entire rows)
		 * 2. **Changes inside a row** (modifying fields within an existing row)
		 *
		 * ## How we map Y.js events to your callbacks
		 *
		 * ### onAdd: When a new row is added
		 *
		 * Triggered when an entire row Y.Map is added to the table:
		 * ```typescript
		 * ytable.set('new-row-id', new Y.Map([['title', 'Hello']]));
		 * ```
		 *
		 * Internally: We check `event.target === ytable` and `change.action === 'add'`
		 *
		 * ### onDelete: When a row is removed
		 *
		 * Triggered when an entire row Y.Map is removed from the table:
		 * ```typescript
		 * ytable.delete('old-row-id');
		 * ```
		 *
		 * Internally: We check `event.target === ytable` and `change.action === 'delete'`
		 *
		 * ### onUpdate: When anything changes inside a row
		 *
		 * This is where it gets interesting. onUpdate fires for ALL changes to fields within
		 * an existing row:
		 *
		 * ```typescript
		 * // Modifying an existing field
		 * yrow.set('title', 'New Title');
		 *
		 * // Adding a new field
		 * yrow.set('newField', 'value');
		 *
		 * // Removing a field
		 * yrow.delete('oldField');
		 *
		 * // Editing Y.Text content
		 * yrow.get('description').insert(0, 'Prefix: ');
		 *
		 * // Modifying Y.Array content
		 * yrow.get('tags').push(['new-tag']);
		 * ```
		 *
		 * All of these trigger onUpdate, regardless of whether the field was added, modified,
		 * or deleted. Why? Because semantically, they're all "the row changed." You get the
		 * entire row object in the callback, so you can inspect what specifically changed if
		 * needed.
		 *
		 * Internally: We check `event.path.length === 1` (meaning the change happened one level
		 * deep: inside a row, not at the table level). When this fires, we call onUpdate with
		 * the full row data.
		 *
		 * ## Why we don't handle top-level 'update' events
		 *
		 * You might notice we only handle 'add' and 'delete' at the table level, not 'update'.
		 * That's intentional.
		 *
		 * A top-level 'update' event would only fire if we completely replaced a row's Y.Map
		 * with a new Y.Map:
		 * ```typescript
		 * ytable.set('existing-row', new Y.Map());  // Replace entire row
		 * ```
		 *
		 * We never do this. Instead, we always modify fields within the existing row Y.Map:
		 * ```typescript
		 * const yrow = ytable.get('existing-row');
		 * yrow.set('title', 'Updated');  // Modify field in existing row
		 * ```
		 *
		 * This fires nested events (detected by `event.path.length === 1`), which trigger
		 * onUpdate. So all row updates are caught by the nested event handler, making the
		 * top-level 'update' check unnecessary.
		 *
		 * ## Design philosophy: Simplicity over granularity
		 *
		 * We could expose more granular callbacks like "onFieldAdded", "onFieldDeleted",
		 * "onFieldModified", but that would complicate the API. Instead:
		 *
		 * - **Simple mental model**: "The row changed" vs "Field X was added, field Y modified"
		 * - **Full context**: You receive the entire row, so you can inspect changes yourself
		 * - **Cleaner code**: Three callbacks instead of many
		 *
		 * ## Validation and Result types
		 *
		 * The onAdd and onUpdate callbacks receive Result types that may contain validation errors.
		 * This allows you to handle invalid rows according to your needs (log them, track in diagnostics, etc.)
		 * rather than silently skipping them.
		 *
		 * @param callbacks Object with optional callbacks for row lifecycle events
		 * @param callbacks.onAdd Called when a new row is added (receives Result with row or validation errors)
		 * @param callbacks.onUpdate Called when any field within an existing row changes (receives Result with row or validation errors)
		 * @param callbacks.onDelete Called when a row is removed (receives row ID only)
		 * @returns Unsubscribe function to stop observing changes
		 */
		observe(callbacks: {
			onAdd?: (
				result: Result<TRow, RowValidationError>,
			) => void | Promise<void>;
			onUpdate?: (
				result: Result<TRow, RowValidationError>,
			) => void | Promise<void>;
			onDelete?: (id: string) => void | Promise<void>;
		}): () => void {
			const yjsValidator = validators.toYjsArktype();

			const observer = (events: Y.YEvent<Y.Map<YRow> | YRow>[]) => {
				for (const event of events) {
					// Top-level events: row additions/deletions in the table
					// event.target === ytable means the change happened directly on the table Y.Map
					if (event.target === ytable) {
						event.changes.keys.forEach((change, key) => {
							if (change.action === 'add') {
								// A new row Y.Map was added to the table
								const yrow = ytable.get(key);
								if (yrow) {
									const row = buildRowFromYRow(yrow, schema);
									const result = yjsValidator(row);

									if (result instanceof type.errors) {
										callbacks.onAdd?.(
											RowValidationErr({
												message: `Row '${key}' in table '${tableName}' failed validation`,
												context: {
													tableName,
													id: key,
													errors: result,
													summary: result.summary,
												},
											}),
										);
									} else {
										callbacks.onAdd?.(Ok(row));
									}
								}
							} else if (change.action === 'delete') {
								// A row Y.Map was removed from the table
								callbacks.onDelete?.(key);
							}
							// Note: We intentionally don't handle 'update' here because:
							// - 'update' only fires if an entire row Y.Map is replaced with another Y.Map
							// - We never do this in our codebase; we only mutate fields within rows
							// - If we ever needed to support this pattern, we would add:
							//   else if (change.action === 'update') { callbacks.onUpdate?.(...) }
						});
					} else if (event.path.length === 1 && event.changes.keys.size > 0) {
						// Nested events: field modifications within a row
						// event.path[0] is the row ID, event.target is the row's Y.Map
						// Any field change (add/update/delete) is treated as a row update
						const rowId = event.path[0] as string;
						const yrow = ytable.get(rowId);
						if (yrow) {
							const row = buildRowFromYRow(yrow, schema);
							const result = yjsValidator(row);

							if (result instanceof type.errors) {
								callbacks.onUpdate?.(
									RowValidationErr({
										message: `Row '${rowId}' in table '${tableName}' failed validation`,
										context: {
											tableName,
											id: rowId,
											errors: result,
											summary: result.summary,
										},
									}),
								);
							} else {
								callbacks.onUpdate?.(Ok(row));
							}
						}
					}
					// Note: We use event.path.length === 1 to detect row-level changes
					// If you have Y.Maps/Y.Arrays nested within row fields, those would have
					// event.path.length > 1. Change to >= 1 if you need to support that.
				}
			};

			ytable.observeDeep(observer);

			return () => {
				ytable.unobserveDeep(observer);
			};
		},

		/**
		 * Type inference helper for SerializedRow.
		 *
		 * SerializedRow is the plain JavaScript representation of a row,
		 * used for insert, update, and upsert operations.
		 *
		 * @example
		 * ```typescript
		 * type Post = typeof db.posts.$inferSerializedRow;
		 * const post: typeof db.posts.$inferSerializedRow = {
		 *   id: '1',
		 *   title: 'Hello',
		 *   content: 'World',
		 * };
		 * db.posts.insert(post);
		 * ```
		 */
		$inferSerializedRow: null as unknown as SerializedRow<TTableSchema>,

		/**
		 * Type inference helper for Row.
		 *
		 * Row is the YJS-backed representation returned from get() and getAll().
		 * It includes the toJSON() method for serialization.
		 *
		 * @example
		 * ```typescript
		 * type Post = typeof db.posts.$inferRow;
		 * const result = db.posts.get({ id: '1' });
		 * if (result.data) {
		 *   const post: Post = result.data; // Row with YJS backing
		 * }
		 * ```
		 */
		$inferRow: null as unknown as Row<TTableSchema>,
	};
}

/**
 * Type-safe table helper with operations for a specific table schema.
 *
 * Write methods return Result types with specific errors:
 * - insert/insertMany: Result<void, RowAlreadyExistsError>
 * - update/updateMany: Result<void, RowNotFoundError>
 * - upsert/upsertMany/delete/deleteMany/clear: Result<void, never> (never fail)
 *
 * Read methods (get, getAll) return null for not-found rather than errors.
 */
export type TableHelper<TTableSchema extends TableSchema> = ReturnType<
	typeof createTableHelper<TTableSchema>
>;

/**
 * Creates a Row object from a YRow with getters for each property.
 * Properly inspectable in console.log while maintaining transparent delegation to YRow.
 * Includes toJSON and $yRow as non-enumerable properties.
 *
 * @internal
 */
function buildRowFromYRow<TSchema extends TableSchema>(
	yrow: YRow,
	schema: TSchema,
): Row<TSchema> {
	const descriptors = Object.fromEntries(
		Array.from(yrow.keys()).map((key) => [
			key,
			{
				get: () => yrow.get(key),
				enumerable: true,
				configurable: true,
			},
		]),
	);

	const row: Record<string, unknown> = {};
	Object.defineProperties(row, descriptors);

	// Add special properties as non-enumerable
	Object.defineProperties(row, {
		toJSON: {
			value: () => {
				const result: Record<string, unknown> = {};
				for (const key in schema) {
					const value = yrow.get(key);
					if (value !== undefined) {
						result[key] = serializeCellValue(value);
					}
				}
				return result as SerializedRow<TSchema>;
			},
			enumerable: false,
			configurable: true,
		},
		$yRow: {
			value: yrow,
			enumerable: false,
			configurable: true,
		},
	});

	return row as Row<TSchema>;
}
