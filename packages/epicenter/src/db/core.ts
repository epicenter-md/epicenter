import * as Y from 'yjs';
import type {
	CellValue,
	Row,
	TableSchema,
	ValidatedRow,
	WorkspaceSchema
} from '../core/schema';
import {
	type GetRowResult,
	type RowValidationResult,
	validateRow,
} from '../core/validation';
import { syncYArrayToDiff, syncYTextToDiff } from '../utils/yjs';

/**
	* YJS representation of a row
	* Maps column names to YJS shared types or primitives
	*/
export type YRow = Y.Map<CellValue>;

/**
	* Converts a YJS row to a plain Row object
	*
	* This is a one-way conversion. We don't need the reverse (Row to YRow) because:
	* - Row updates are always granular (using yrow.set(key, value) for specific fields)
	* - Full row conversions only happen when reading data (get, getAll, filter, etc.)
	* - YJS handles the conversion from plain values to Y.Map internally during insert/update
	*/
export function toRow(yrow: YRow): Row {
	return Object.fromEntries(yrow.entries()) as Row;
}

/**
	* Transform Y.js types to their serializable equivalents for input operations.
	* - Y.Text → string
	* - Y.Array<T> → T[]
	* - Other types remain unchanged
	*
	* Handles nullable types automatically due to distributive conditional types:
	* - SerializeYjsType<Y.Text | null> = string | null
	* - SerializeYjsType<Y.Array<string> | null> = string[] | null
	*/
type SerializeYjsType<T> = T extends Y.Text
	? string
	: T extends Y.Array<infer U>
	? U[]
	: T;

/**
	* Input row type for insert/update operations.
	* Y.Text fields accept strings, Y.Array fields accept plain arrays.
	* Other fields remain unchanged.
	*
	* @example
	* ```typescript
	* // Schema defines Y.Text and Y.Array
	* type Schema = {
	*   id: IdColumnSchema;
	*   content: YtextColumnSchema<false>;
	*   tags: MultiSelectColumnSchema<['a', 'b'], false>;
	* };
	*
	* // ValidatedRow has Y.js types
	* type Row = ValidatedRow<Schema>;
	* // { id: string; content: Y.Text; tags: Y.Array<'a' | 'b'> }
	*
	* // InputRow has serializable types
	* type Input = InputRow<Row>;
	* // { id: string; content: string; tags: ('a' | 'b')[] }
	* ```
	*/
export type InputRow<TRow extends Row = Row> = {
	[K in keyof TRow]: SerializeYjsType<TRow[K]>;
};

/**
	* Represents a partial row update where id is required but all other fields are optional.
	*
	* Takes a regular Row type (TRow), wraps it with InputRow<TRow> to get the input variant,
	* then makes all fields except 'id' optional.
	*
	* Only the fields you include will be updated - the rest remain unchanged. Each field is
	* updated individually in the underlying YJS Map.
	*
	* @example
	* // Update only the title field, leaving other fields unchanged
	* db.tables.posts.update({ id: '123', title: 'New Title' });
	*
	* @example
	* // Update multiple fields at once
	* db.tables.posts.update({ id: '123', title: 'New Title', published: true });
	*/
type PartialInputRow<TRow extends Row = Row> =
	Pick<InputRow<TRow>, 'id'> & Partial<Omit<InputRow<TRow>, 'id'>>;

/**
	* Type-safe table helper with operations for a specific table schema
	*/
export type TableHelper<TRow extends Row> = {
	/**
		* Insert a new row into the table.
		*
		* For Y.js columns (ytext, multi-select), provide plain JavaScript values:
		* - ytext columns accept strings
		* - multi-select columns accept arrays
		*
		* Internally, strings are synced to Y.Text using syncYTextToDiff(),
		* and arrays are synced to Y.Array using syncYArrayToDiff().
		*
		* @example
		* // Insert with plain values
		* table.insert({
		*   id: '123',
		*   content: 'Hello World',           // string for ytext
		*   tags: ['typescript', 'react'],    // array for multi-select
		*   viewCount: 0                      // primitive number
		* });
		*
		* @example
		* // For collaborative editing, get the Y.js reference
		* const row = table.get('123');
		* if (row.status === 'valid') {
		*   editor.bindYText(row.row.content);  // Bind to editor
		*   row.row.content.insert(0, 'prefix: '); // Direct mutation syncs
		* }
		*/
	insert(row: InputRow<TRow>): void;

	/**
		* Update specific fields of an existing row.
		*
		* For Y.js columns (ytext, multi-select), provide plain JavaScript values:
		* - ytext columns accept strings
		* - multi-select columns accept arrays
		*
		* Internally, the existing Y.Text/Y.Array is synced using syncYTextToDiff()
		* or syncYArrayToDiff() to apply minimal changes while preserving CRDT history.
		*
		* Only the fields you include will be updated - others remain unchanged.
		*
		* @example
		* // Update with plain values
		* table.update({
		*   id: '123',
		*   content: 'Updated content',        // string for ytext
		*   tags: ['new', 'tags']              // array for multi-select
		* });
		*
		* @example
		* // For granular collaborative edits, get Y.js reference directly
		* const row = table.get('123');
		* if (row.status === 'valid') {
		*   row.row.content.insert(0, 'prefix: '); // Granular text edit
		*   row.row.tags.push(['new-tag']);        // Granular array change
		* }
		*/
	update(partial: PartialInputRow<TRow>): void;

	/**
		* Insert or update a row (insert if doesn't exist, update if exists).
		*
		* For Y.js columns (ytext, multi-select), provide plain JavaScript values.
		* Internally syncs using syncYTextToDiff() and syncYArrayToDiff().
		*
		* @example
		* table.upsert({
		*   id: '123',
		*   content: 'Hello World',
		*   tags: ['typescript']
		* });
		*/
	upsert(row: InputRow<TRow>): void;

	insertMany(rows: InputRow<TRow>[]): void;
	upsertMany(rows: InputRow<TRow>[]): void;
	updateMany(partials: PartialInputRow<TRow>[]): void;

	/**
		* Get a row by ID, returning Y.js objects for collaborative editing.
		*
		* Returns Y.Text and Y.Array objects that can be:
		* - Bound to collaborative editors (CodeMirror, etc.)
		* - Mutated directly for automatic sync across clients
		*
		* @example
		* const result = table.get('123');
		* if (result.status === 'valid') {
		*   const row = result.row;
		*   row.title // Y.Text - bind to editor
		*   row.tags // Y.Array<string> - mutate directly
		* }
		*/
	get(id: string): GetRowResult<TRow>;

	/**
		* Get all rows with Y.js objects for collaborative editing.
		*/
	getAll(): RowValidationResult<TRow>[];

	has(id: string): boolean;
	delete(id: string): void;
	deleteMany(ids: string[]): void;
	clear(): void;
	count(): number;
	filter(predicate: (row: TRow) => boolean): RowValidationResult<TRow>[];
	find(predicate: (row: TRow) => boolean): GetRowResult<TRow>;
	observe(callbacks: {
		onAdd?: (row: TRow) => void | Promise<void>;
		onUpdate?: (row: TRow) => void | Promise<void>;
		onDelete?: (id: string) => void | Promise<void>;
	}): () => void;
};

/**
	* Create an Epicenter database wrapper with table helpers from an existing Y.Doc.
	* This is a pure function that doesn't handle persistence - it only wraps
	* the Y.Doc with type-safe table operations.
	*
	* @param ydoc - An existing Y.Doc instance (already loaded/initialized)
	* @param schema - Table schema definitions
	* @returns Object with table helpers and document utilities
	*
	* @example
	* ```typescript
	* // With a fresh Y.Doc
	* const ydoc = new Y.Doc({ guid: 'workspace-123' });
	* const db = createEpicenterDb(ydoc, {
	*   posts: {
	*     id: id(),
	*     title: text(),
	*     published: boolean(),
	*   }
	* });
	*
	* // Or with a Y.Doc from a network provider
	* const provider = new WebrtcProvider('room-name', ydoc);
	* const db = createEpicenterDb(ydoc, schemas);
	* ```
	*/
export function createEpicenterDb<TWorkspaceSchema extends WorkspaceSchema>(
	ydoc: Y.Doc,
	schema: TWorkspaceSchema,
) {
	const ytables = ydoc.getMap<Y.Map<YRow>>('tables');

	// Initialize each table as a Y.Map<id, row> (only if not already present)
	// When loading from disk or syncing from network, tables may already exist
	for (const tableName of Object.keys(schema)) {
		if (!ytables.has(tableName)) {
			ytables.set(tableName, new Y.Map<YRow>());
		}
	}

	return {
		/**
			* Table helpers organized by table name
			* Each table has methods for type-safe CRUD operations
			*/
		tables: createTableHelpers({ ydoc, schema, ytables }),

		/**
			* The underlying YJS document
			* Exposed for persistence and sync providers
			*/
		ydoc,

		/**
			* Table schemas for all tables
			* Maps table name to column schemas
			*/
		schema,

		/**
			* Execute a function within a YJS transaction
			*
			* Transactions bundle changes and ensure atomic updates. All changes within
			* a transaction are sent as a single update to collaborators.
			*
			* **Nested Transactions:**
			* YJS handles nested transact() calls safely by reusing the outer transaction.
			*
			* - First transact() creates a transaction (sets doc._transaction, initialCall = true)
			* - Nested transact() calls check if doc._transaction exists and reuse it
			* - Inner transact() calls are essentially no-ops - they just execute their function
			* - Only the outermost transaction (where initialCall = true) triggers cleanup and events
			*
			* This means it's safe to:
			* - Call table methods inside a transaction (they use transact internally)
			* - Nest transactions for cross-table operations
			*
			* @example
			* ```typescript
			* // Single operation - automatically transactional
			* doc.tables.posts.insert({ id: '1', title: 'Hello', ... });
			*
			* // Batch operation - wrapped in transaction
			* doc.tables.posts.insertMany([{ id: '1', ... }, { id: '2', ... }]);
			*
			* // Cross-table transaction - safe nesting
			* doc.transact(() => {
			*   doc.tables.posts.upsertMany([...]); // reuses outer transaction
			*   doc.tables.users.insert({ ... }); // also reuses outer transaction
			* }, 'bulk-import');
			* ```
			*/
		transact(fn: () => void, origin?: string): void {
			ydoc.transact(fn, origin);
		},

		/**
			* Get all table names in the document
			*/
		getTableNames(): string[] {
			return Object.keys(schema);
		},
	};
}

/**
	* Type alias for the return type of createEpicenterDb
	* Useful for typing function parameters that accept a database instance
	*
	* @example
	* ```typescript
	* type MyDb = Db<typeof mySchema>;
	*
	* function doSomething(db: MyDb) {
	*   db.tables.posts.insert(...);
	* }
	* ```
	*/
export type Db<TWorkspaceSchema extends WorkspaceSchema> = ReturnType<
	typeof createEpicenterDb<TWorkspaceSchema>
>;

/**
	* Creates a type-safe collection of table helpers for all tables in a schema.
	*
	* This function maps over the table schemas and creates a TableHelper for each table,
	* returning an object where each key is a table name and each value is the corresponding
	* typed helper with full CRUD operations.
	*
	* @param ydoc - The YJS document instance
	* @param schema - Schema definitions for all tables
	* @param ytables - The root YJS Map containing all table data
	* @returns Object mapping table names to their typed TableHelper instances
	*/
function createTableHelpers<TWorkspaceSchema extends WorkspaceSchema>({
	ydoc,
	schema,
	ytables,
}: {
	ydoc: Y.Doc;
	schema: TWorkspaceSchema;
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
				createTableHelper({ ydoc, tableName, ytable, schema: tableSchema }),
			];
		}),
	) as {
			[TTableName in keyof TWorkspaceSchema]: TableHelper<
				ValidatedRow<TWorkspaceSchema[TTableName]>
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
	* @param schema - The table schema for validation
	* @returns A TableHelper instance with full CRUD operations
	*/
function createTableHelper<TTableSchema extends TableSchema>({
	ydoc,
	tableName,
	ytable,
	schema,
}: {
	ydoc: Y.Doc;
	tableName: string;
	ytable: Y.Map<YRow>;
	schema: TTableSchema;
}): TableHelper<ValidatedRow<TTableSchema>> {
	type TRow = ValidatedRow<TTableSchema>;

	/**
		* Validates a row and returns validation result typed as TRow
		* The generic validateRow() returns RowValidationResult<ValidatedRow<TableSchema>>,
		* but we need the specific TRow type for this table. This wrapper narrows the type from
		* the generic schema to the concrete row type, enabling proper type inference throughout
		* the table helper.
		*/
	const validateTypedRow = (data: unknown): RowValidationResult<TRow> => {
		const result = validateRow(data, schema);
		if (result.status === 'valid') {
			return { status: 'valid', row: result.row };
		}
		return result;
	};

	/**
	* Syncs an InputRow (or partial InputRow) to a YRow, converting plain JS values to Y.js types.
	*
	* Type conversion rules:
	* - string[] → Y.Array: ALWAYS converted, regardless of schema type (YJS cannot store plain arrays)
	* - string → Y.Text: Only when columnSchema.type === 'ytext' (other string columns stay as primitives)
	* - Other types (number, boolean, etc.): Set directly as primitives
	*
	* This function handles both new and existing rows:
	* - For new rows, Y.js objects are created fresh
	* - For existing rows, Y.js objects are reused and synced with minimal diffs
	*/
	const syncInputRowToYRow = ({
		yrow,
		inputRow,
	}: {
		yrow: YRow;
		inputRow: PartialInputRow<TRow>;
	}): void => {
		const isYArray = (value: unknown): value is Y.Array<any> => value instanceof Y.Array
		const isYText = (value: unknown): value is Y.Text => value instanceof Y.Text
		const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

		for (const [key, value] of Object.entries(inputRow)) {
			// Skip undefined values (used in partial updates to leave fields unchanged)
			if (value === undefined) continue;

			const columnSchema = schema[key];
			if (!columnSchema) continue;

			// Handle null early - always write null regardless of type
			if (value === null) {
				yrow.set(key, null);
				continue;
			}

			// At this point, value is definitely not null or undefined
			// Reverse serialize: convert serialized input types back to YJS types
			if (columnSchema.type === 'ytext' && typeof value === 'string') {
				// Reverse: string → Y.Text (only for ytext columns)
				let ytext = yrow.get(key)
				if (!isYText(ytext)) {
					ytext = new Y.Text();
					yrow.set(key, ytext);
				}
				syncYTextToDiff(ytext, value);
			} else if (isArray(value)) {
				// Reverse: string[] → Y.Array (always)
				let yarray = yrow.get(key)
				if (!isYArray(yarray)) {
					yarray = new Y.Array();
					yrow.set(key, yarray);
				}
				syncYArrayToDiff(yarray, value);
			} else {
				// Primitives (string, number, boolean, date) stored as-is
				yrow.set(key, value);
			}
		}
	};

	return {
		insert(row: InputRow<TRow>) {
			ydoc.transact(() => {
				if (ytable.has(row.id)) {
					throw new Error(
						`Row with id "${row.id}" already exists in table "${tableName}"`,
					);
				}
				const yrow = new Y.Map<CellValue>();
				syncInputRowToYRow({ yrow, inputRow: row });
				ytable.set(row.id, yrow);
			});
		},

		update(partial: PartialInputRow<TRow>) {
			ydoc.transact(() => {
				const yrow = ytable.get(partial.id);
				if (!yrow) {
					throw new Error(
						`Row with id "${partial.id}" not found in table "${tableName}"`,
					);
				}
				syncInputRowToYRow({ yrow, inputRow: partial });
			});
		},

		upsert(row: InputRow<TRow>) {
			ydoc.transact(() => {
				let yrow = ytable.get(row.id);
				if (!yrow) {
					yrow = new Y.Map<CellValue>();
					ytable.set(row.id, yrow);
				}
				syncInputRowToYRow({ yrow, inputRow: row });
			});
		},

		insertMany(rows: InputRow<TRow>[]) {
			ydoc.transact(() => {
				for (const row of rows) {
					if (ytable.has(row.id)) {
						throw new Error(
							`Row with id "${row.id}" already exists in table "${tableName}"`,
						);
					}
					const yrow = new Y.Map<CellValue>();
					syncInputRowToYRow({ yrow, inputRow: row });
					ytable.set(row.id, yrow);
				}
			});
		},

		upsertMany(rows: InputRow<TRow>[]) {
			ydoc.transact(() => {
				for (const row of rows) {
					let yrow = ytable.get(row.id);
					if (!yrow) {
						yrow = new Y.Map<CellValue>();
						ytable.set(row.id, yrow);
					}
					syncInputRowToYRow({ yrow, inputRow: row });
				}
			});
		},

		updateMany(partials: PartialInputRow<TRow>[]) {
			ydoc.transact(() => {
				for (const partial of partials) {
					const yrow = ytable.get(partial.id);
					if (!yrow) {
						throw new Error(
							`Row with id "${partial.id}" not found in table "${tableName}"`,
						);
					}
					syncInputRowToYRow({ yrow, inputRow: partial });
				}
			});
		},

		get(id: string): GetRowResult<TRow> {
			const yrow = ytable.get(id);
			if (!yrow) {
				return { status: 'not-found', row: null };
			}

			const row = toRow(yrow);
			return validateTypedRow(row);
		},

		getAll() {
			// Functional equivalent (slower, multiple passes):
			// return Array.from(ytable.values()).map(toRow).map(validateTypedRow);
			const results: RowValidationResult<TRow>[] = [];
			for (const yrow of ytable.values()) {
				const row = toRow(yrow);
				const result = validateTypedRow(row);
				results.push(result);
			}

			return results;
		},

		has(id: string) {
			return ytable.has(id);
		},

		delete(id: string) {
			ydoc.transact(() => {
				ytable.delete(id);
			});
		},

		deleteMany(ids: string[]) {
			ydoc.transact(() => {
				for (const id of ids) {
					ytable.delete(id);
				}
			});
		},

		clear() {
			ydoc.transact(() => {
				ytable.clear();
			});
		},

		count() {
			return ytable.size;
		},

		filter(predicate: (row: TRow) => boolean) {
			// Functional equivalent (slower, multiple passes):
			// return Array.from(ytable.values())
			//     .map(toRow)
			//     .filter((row) => predicate(row as TRow))
			//     .map(validateTypedRow);
			const results: RowValidationResult<TRow>[] = [];

			for (const yrow of ytable.values()) {
				const row = toRow(yrow);

				// Check predicate first (even on unvalidated rows)
				if (predicate(row as TRow)) {
					const result = validateTypedRow(row);
					results.push(result);
				}
			}

			return results;
		},

		find(predicate: (row: TRow) => boolean): GetRowResult<TRow> {
			for (const yrow of ytable.values()) {
				const row = toRow(yrow);

				// Check predicate first (even on unvalidated rows)
				if (predicate(row as TRow)) {
					return validateTypedRow(row);
				}
			}

			// No match found (not an error, just no matching row)
			return { status: 'not-found', row: null };
		},

		observe(callbacks: {
			onAdd?: (row: TRow) => void | Promise<void>;
			onUpdate?: (row: TRow) => void | Promise<void>;
			onDelete?: (id: string) => void | Promise<void>;
		}): () => void {
			const observer = (events: Y.YEvent<any>[]) => {
				for (const event of events) {
					// Check if this is a top-level ytable event (row add/delete)
					// or a nested yrow event (field updates)
					if (event.target === ytable) {
						// Top-level changes: row additions/deletions
						event.changes.keys.forEach((change, key) => {
							if (change.action === 'add') {
								const yrow = ytable.get(key);
								if (yrow) {
									const row = toRow(yrow);
									const result = validateTypedRow(row);

									switch (result.status) {
										case 'valid':
											callbacks.onAdd?.(result.row);
											break;
										case 'schema-mismatch':
										case 'invalid-structure':
											console.warn(
												`Skipping invalid row in ${tableName}/${key} (onAdd): ${result.status}`,
											);
											break;
									}
								}
							} else if (change.action === 'delete') {
								callbacks.onDelete?.(key);
							}
						});
					} else if (event.path.length === 1 && event.changes.keys.size > 0) {
						// Nested change: field updates within a row
						// event.path[0] is the row ID
						const rowId = event.path[0] as string;
						const yrow = ytable.get(rowId);
						if (yrow) {
							const row = toRow(yrow);
							const result = validateTypedRow(row);

							switch (result.status) {
								case 'valid':
									callbacks.onUpdate?.(result.row);
									break;
								case 'schema-mismatch':
								case 'invalid-structure':
									console.warn(
										`Skipping invalid row in ${tableName}/${rowId} (onUpdate): ${result.status}`,
									);
									break;
							}
						}
					}
				}
			};

			ytable.observeDeep(observer);

			return () => {
				ytable.unobserveDeep(observer);
			};
		},
	};
}
