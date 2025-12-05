/**
 * @fileoverview Schema validation functions and validators
 *
 * Provides comprehensive validation for table schemas, including:
 * - Runtime validation of YRow (CRDT) and SerializedRow (plain JS) data
 * - Schema generation for action inputs (toStandardSchema)
 * - Composable arktype schemas (toArktype)
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import type { ObjectType } from 'arktype/internal/variants/object.ts';
import { tableSchemaToArktypeType } from './converters/arktype';
import { tableSchemaToYjsArktypeType } from './converters/arktype-yjs';
import type {
	PartialSerializedRow,
	Row,
	SerializedRow,
	TableSchema,
	WorkspaceSchema,
} from './types';

/**
 * Table validators - validation methods for a table schema.
 * Created by `createTableValidators()` from a `TableSchema`.
 * Contains only validation methods, separate from the schema definition.
 *
 * @example
 * ```typescript
 * const validators = createTableValidators({
 *   id: id(),
 *   title: text(),
 *   content: ytext(),
 * });
 *
 * // Validate unknown data using direct arktype pattern
 * const validator = validators.toArktype();
 * const result = validator(someUnknownData);
 * if (result instanceof type.errors) {
 *   console.error('Validation failed:', result.summary);
 * } else {
 *   console.log(result.title); // type-safe access to validated data
 * }
 * ```
 */
export type TableValidators<TSchema extends TableSchema = TableSchema> = {
	/**
	 * Generates a StandardSchemaV1 for full SerializedRow
	 *
	 * **Primary use case**: Action input schemas
	 * - Used as `input` parameter for mutations (insert, upsert)
	 * - Provides runtime validation via `action.input['~standard'].validate(args)`
	 * - Later converted to JSON Schema by MCP server/OpenAPI generator
	 *
	 * **Example**:
	 * ```typescript
	 * insert: defineMutation({
	 *   input: validators.toStandardSchema(),  // ← Action input
	 *   handler: (serializedRow) => { ... }
	 * })
	 * ```
	 *
	 * **Schema generation flow**:
	 * 1. This method returns StandardSchemaV1
	 * 2. Action uses it as `input` for validation
	 * 3. MCP server converts it to JSON Schema via `toJsonSchema(action.input)`
	 */
	toStandardSchema(): StandardSchemaV1<SerializedRow<TSchema>>;

	/**
	 * Generates a StandardSchemaV1 for partial SerializedRow (all fields except id are optional)
	 *
	 * **Primary use case**: Update action input schemas
	 * - Used for update operations where only some fields are provided
	 * - Example: `update: defineMutation({ input: validators.toPartialStandardSchema() })`
	 */
	toPartialStandardSchema(): StandardSchemaV1<PartialSerializedRow<TSchema>>;

	/**
	 * Generates a StandardSchemaV1 for an array of SerializedRows, wrapped in an object
	 *
	 * **Primary use case**: Batch insert/upsert action input schemas
	 * - Used for operations that accept multiple rows at once
	 * - Example: `insertMany: defineMutation({ input: validators.toStandardSchemaArray() })`
	 *
	 * **MCP compatibility**: Returns `{ rows: T[] }` instead of bare `T[]` because
	 * MCP protocol requires all tool inputSchema to have `type: "object"` at the root.
	 */
	toStandardSchemaArray(): StandardSchemaV1<{ rows: SerializedRow<TSchema>[] }>;

	/**
	 * Generates a StandardSchemaV1 for an array of partial SerializedRows, wrapped in an object
	 *
	 * **Primary use case**: Batch update action input schemas
	 * - Used for bulk update operations with partial data
	 * - Example: `updateMany: defineMutation({ input: validators.toPartialStandardSchemaArray() })`
	 *
	 * **MCP compatibility**: Returns `{ rows: T[] }` instead of bare `T[]` because
	 * MCP protocol requires all tool inputSchema to have `type: "object"` at the root.
	 */
	toPartialStandardSchemaArray(): StandardSchemaV1<{
		rows: PartialSerializedRow<TSchema>[];
	}>;

	/**
	 * Generates an Arktype schema for full SerializedRow
	 *
	 * **Primary use case**: Runtime validation with arktype's composition API
	 * - Use with `.omit()`, `.partial()`, `.pick()` for validating subsets of data
	 * - Common pattern: Validating frontmatter without auto-managed fields
	 * - NOT primarily for JSON Schema generation (use StandardSchemaV1 methods for that)
	 *
	 * **Example**:
	 * ```typescript
	 * // Validate frontmatter excluding id and content
	 * const FrontMatter = table.validators.toArktype().omit('id', 'content');
	 * const result = FrontMatter(frontmatter);
	 * if (result instanceof type.errors) {
	 *   // Handle validation errors
	 * }
	 * ```
	 *
	 * **Real-world usage**:
	 * - Markdown index deserialization (excluding id/content from frontmatter)
	 * - Migration scripts (partial validation with `.omit().partial()`)
	 * - Any scenario requiring validation of schema subsets
	 */
	toArktype(): ObjectType<SerializedRow<TSchema>>;

	/**
	 * Generates an Arktype schema for Row objects with YJS types
	 *
	 * **Primary use case**: Validating Row objects returned from buildRowFromYRow()
	 * - Validates Y.Text instances for ytext columns (not plain strings)
	 * - Validates Y.Array instances for multi-select columns (not plain arrays)
	 * - Use with `instanceof type.errors` pattern for validation
	 *
	 * **Example**:
	 * ```typescript
	 * // Build row from YRow
	 * const row = buildRowFromYRow(yrow, schema);
	 *
	 * // Validate the YJS types
	 * const validator = validators.toYjsArktype();
	 * const result = validator(row);
	 * if (result instanceof type.errors) {
	 *   console.error('YJS validation failed:', result.summary);
	 *   // Handle schema mismatch
	 * } else {
	 *   // Row is valid - has Y.Text, Y.Array, etc.
	 * }
	 * ```
	 *
	 * **Key difference from toArktype()**:
	 * - `toArktype()` validates SerializedRow (plain JS: strings, arrays)
	 * - `toYjsArktype()` validates Row (YJS types: Y.Text, Y.Array)
	 */
	toYjsArktype(): ObjectType<Row<TSchema>>;
};

/**
 * Workspace validators - maps table names to their table validators
 */
export type WorkspaceValidators<TWorkspaceSchema extends WorkspaceSchema> = {
	[TTableName in keyof TWorkspaceSchema]: TableValidators<
		TWorkspaceSchema[TTableName]
	>;
};

/**
 * Creates workspace validators by mapping over all tables in a workspace schema.
 * Returns an object where each key is a table name and each value is the table's validators.
 *
 * @example
 * ```typescript
 * const validators = createWorkspaceValidators({
 *   posts: { id: id(), title: text(), content: ytext() },
 *   users: { id: id(), name: text(), email: text() }
 * });
 *
 * // Use validators for runtime validation with direct arktype pattern
 * const validator = validators.posts.toArktype();
 * const result = validator({ id: '1', title: 'Hello', content: 'World' });
 * if (result instanceof type.errors) {
 *   console.error('Validation failed:', result.summary);
 * } else {
 *   console.log(result.title); // type-safe access
 * }
 *
 * // Use validators for action input schemas
 * const insertMutation = defineMutation({
 *   input: validators.posts.toStandardSchema(),
 *   handler: (row) => { ... }
 * });
 *
 * // Use validators for composable arktype schemas
 * const PostFrontmatter = validators.posts.toArktype().omit('id', 'content');
 * ```
 */
export function createWorkspaceValidators<
	TWorkspaceSchema extends WorkspaceSchema,
>(schema: TWorkspaceSchema): WorkspaceValidators<TWorkspaceSchema> {
	return Object.fromEntries(
		Object.entries(schema).map(([tableName, tableSchema]) => [
			tableName,
			createTableValidators(tableSchema),
		]),
	) as WorkspaceValidators<TWorkspaceSchema>;
}

/**
 * Creates table validators from a schema definition.
 * Returns validation methods and schema generation utilities.
 *
 * **Architecture Overview**: This function provides two distinct capabilities:
 *
 * **1. Action Input Schemas** (via `toStandardSchema()` and variants):
 * - Generates StandardSchemaV1 for action `input` parameters
 * - Used by mutations (insert, update, upsert, etc.) for input validation
 * - Provides runtime validation via `action.input['~standard'].validate(args)`
 * - Later converted to JSON Schema by MCP server/OpenAPI generator
 * - Must use JSON Schema-compatible features (no custom predicates like `.filter()`)
 *
 * **2. Composable Runtime Validation** (via `toArktype()`):
 * - Returns arktype schemas that can be composed using `.omit()`, `.partial()`, `.pick()`
 * - Used for validating subsets of data (e.g., frontmatter without id/content)
 * - Common in markdown deserialization and migration scripts
 * - Call the returned validator on data and check `instanceof type.errors`
 *
 * **Key constraint**: StandardSchemaV1 methods must maintain JSON Schema compatibility
 * because MCP servers and OpenAPI generators convert them to JSON Schema. This means:
 * - JSON columns return `type.unknown` (actual validation happens via arktype)
 * - Date columns use `.matching(regex)` instead of `.filter()` predicates
 * - No custom predicates that can't be represented in JSON Schema
 *
 * @example
 * ```typescript
 * const schema = {
 *   id: id(),
 *   title: text(),
 *   content: ytext(),
 * };
 * const validators = createTableValidators(schema);
 *
 * // 1. Runtime validation with direct arktype pattern
 * const validator = validators.toArktype();
 * const result = validator(someData);
 * if (result instanceof type.errors) {
 *   console.error('Validation failed:', result.summary);
 * } else {
 *   console.log(result.title); // type-safe access
 * }
 *
 * // 2. Action input schema
 * const insertMutation = defineMutation({
 *   input: validators.toStandardSchema(),  // For action input validation
 *   handler: (row) => { ... }
 * });
 *
 * // 3. Composable validation (e.g., for frontmatter without id/content)
 * const FrontMatter = validators.toArktype().omit('id', 'content');
 * const result2 = FrontMatter(frontmatter);
 * if (result2 instanceof type.errors) {
 *   // Handle error
 * }
 * ```
 */
export function createTableValidators<TSchema extends TableSchema>(
	schema: TSchema,
): TableValidators<TSchema> {
	return {
		toArktype() {
			return tableSchemaToArktypeType(schema);
		},

		toYjsArktype() {
			return tableSchemaToYjsArktypeType(schema);
		},

		toStandardSchema() {
			return this.toArktype() as StandardSchemaV1<SerializedRow<TSchema>>;
		},

		toPartialStandardSchema() {
			// Make all keys optional, then override 'id' to remain required
			return this.toArktype()
				.partial()
				.merge({ id: 'string' }) as StandardSchemaV1<
				PartialSerializedRow<TSchema>
			>;
		},

		toStandardSchemaArray() {
			// Wrap in object for MCP compatibility (MCP requires type: "object" at root)
			return type({ rows: this.toArktype().array() }) as StandardSchemaV1<{
				rows: SerializedRow<TSchema>[];
			}>;
		},

		toPartialStandardSchemaArray() {
			// Wrap in object for MCP compatibility (MCP requires type: "object" at root)
			return type({
				rows: this.toArktype().partial().merge({ id: type.string }).array(),
			}) as StandardSchemaV1<{ rows: PartialSerializedRow<TSchema>[] }>;
		},
	};
}
