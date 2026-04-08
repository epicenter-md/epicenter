/**
 * defineTable() for creating versioned table definitions.
 *
 * All table schemas must include `_v: number` as a discriminant field.
 * The underscore prefix signals framework metadata—see `BaseRow` in
 * `types.ts` for the full rationale.
 *
 * Use shorthand for single-version tables, variadic args for multiple versions with migrations.
 *
 * Optionally chain `.withDocument()` to declare named document configs on the table.
 * @example
 * ```typescript
 * import { defineTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Shorthand with document config
 * const files = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // Variadic for multiple versions with migration
 * const posts = defineTable(
 *   type({ id: 'string', title: 'string', _v: '1' }),
 *   type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, views: 0, _v: 2 };
 *     case 2: return row;
 *   }
 * });
 *
 * // Shorthand with document config (multiple documents)
 * const notes = defineTable(
 *   type({ id: 'string', bodyDocId: 'string', bodyUpdatedAt: 'number', _v: '1' }),
 * ).withDocument('body', {
 *   guid: 'bodyDocId',
 *   onUpdate: () => ({ bodyUpdatedAt: Date.now() }),
 * });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CombinedStandardSchema } from '../shared/standard-schema/types.js';
import { createUnionSchema } from './schema-union.js';
import type {
	AwarenessDefinitions,
	BaseRow,
	ClaimedDocumentColumns,
	DocumentConfig,
	LastSchema,
	StringKeysOf,
	TableDefinition,
} from './types.js';

/**
 * A table definition with a chainable `.withDocument()` method.
 *
 * Returned by both the shorthand `defineTable(schema)` and the builder's `.migrate()`.
 * Each `.withDocument()` call accumulates a named document config into `TDocuments`.
 *
 * @typeParam TVersions - Tuple of schema versions
 * @typeParam TDocuments - Accumulated document configs
 */
type TableDefinitionWithDocBuilder<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[],
	TDocuments extends Record<string, DocumentConfig>,
> = TableDefinition<TVersions, TDocuments> & {
	/**
	 * Declare a named document on this table.
	 *
	 * Maps a document concept (e.g., 'content') to a GUID column and an `onUpdate` callback.
	 * The name becomes a property under `client.documents.{tableName}` at runtime.
	 *
	 * Chainable — call multiple times for tables with multiple documents.
	 * Each call claims its `guid` column exclusively — subsequent calls cannot reuse
	 * a GUID column already bound to a prior document (prevents storage collisions).
	 *
	 * @param name - The document name (becomes `client.documents.{tableName}[name]`)
	 * @param config - `guid` (string column) and `onUpdate` (callback returning partial row)
	 *
	 * @example
	 * ```typescript
	 * const files = defineTable(
	 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
	 * ).withDocument('content', {
	 *   guid: 'id',
	 *   onUpdate: () => ({ updatedAt: Date.now() }),
	 * });
	 *
	 * // Multiple documents — each must use a unique guid column
	 * const notes = defineTable(
	 *   type({ id: 'string', bodyDocId: 'string', coverDocId: 'string',
	 *          updatedAt: 'number', _v: '1' }),
	 * )
	 *   .withDocument('body', {
	 *     guid: 'bodyDocId',
	 *     onUpdate: () => ({ updatedAt: Date.now() }),
	 *   })
	 *   .withDocument('cover', {
	 *     guid: 'coverDocId',
	 *     onUpdate: () => ({ updatedAt: Date.now() }),
	 *   });
	 * ```
	 */
	withDocument<
		TName extends string,
		TGuid extends Exclude<
			StringKeysOf<StandardSchemaV1.InferOutput<LastSchema<TVersions>>>,
			ClaimedDocumentColumns<TDocuments>
		>,
		const TAwarenessDefs extends AwarenessDefinitions = Record<string, never>,
	>(
		name: TName,
		config: {
			guid: TGuid;
			onUpdate: () => Partial<
				Omit<StandardSchemaV1.InferOutput<LastSchema<TVersions>>, 'id'>
			>;
			awareness?: TAwarenessDefs;
		},
	): TableDefinitionWithDocBuilder<
		TVersions,
		TDocuments &
			Record<
				TName,
				DocumentConfig<
					TGuid,
					StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
					TAwarenessDefs
				>
			>
	>;
};

/**
 * Creates a table definition with a single schema version.
 * Schema must include `{ id: string, _v: number }`.
 *
 * For single-version definitions, the TVersions tuple contains a single element.
 *
 * @example
 * ```typescript
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 * ```
 */
export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
	schema: TSchema,
): TableDefinitionWithDocBuilder<[TSchema], Record<string, never>>;

/**
 * Creates a table definition for multiple schema versions with migrations.
 *
 * Pass 2+ schemas as arguments, then call `.migrate()` on the result to provide
 * a migration function that normalizes any version to the latest.
 *
 * @example
 * ```typescript
 * const posts = defineTable(
 *   type({ id: 'string', title: 'string', _v: '1' }),
 *   type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, views: 0, _v: 2 };
 *     case 2: return row;
 *   }
 * });
 * ```
 */
export function defineTable<
	const TVersions extends [
		CombinedStandardSchema<BaseRow>,
		CombinedStandardSchema<BaseRow>,
		...CombinedStandardSchema<BaseRow>[],
	],
>(
	...versions: TVersions
): {
	migrate(
		fn: (
			row: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): TableDefinitionWithDocBuilder<TVersions, Record<string, never>>;
};

export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
	...args: [TSchema, ...CombinedStandardSchema<BaseRow>[]]
):
	| TableDefinitionWithDocBuilder<[TSchema], Record<string, never>>
	| {
			migrate(
				fn: (row: unknown) => unknown,
			): TableDefinitionWithDocBuilder<
				CombinedStandardSchema<BaseRow>[],
				Record<string, never>
			>;
	  } {
	if (args.length === 0) {
		throw new Error('defineTable() requires at least one schema argument');
	}

	if (args.length === 1) {
		const schema = args[0];
		return attachDocumentBuilder({
			schema,
			migrate: (row: unknown) => row as BaseRow,
			documents: {} as Record<string, never>,
		}) as unknown as TableDefinitionWithDocBuilder<
			[TSchema],
			Record<string, never>
		>;
	}

	const versions = args as CombinedStandardSchema[];

	return {
		migrate(fn: (row: unknown) => unknown) {
			return attachDocumentBuilder({
				schema: createUnionSchema(versions),
				migrate: fn,
				documents: {},
			});
		},
	} as unknown as TableDefinitionWithDocBuilder<
		CombinedStandardSchema<BaseRow>[],
		Record<string, never>
	>;
}

/**
 * Create a new definition object with a `.withDocument()` chainable method.
 *
 * Each `.withDocument()` call returns a fresh object with the new document config
 * accumulated into `documents` — the original definition is never mutated.
 */
function attachDocumentBuilder<
	T extends {
		schema: CombinedStandardSchema;
		migrate: unknown;
		documents: Record<string, DocumentConfig>;
	},
>(
	def: T,
): T & {
	withDocument(name: string, config: DocumentConfig): T;
} {
	return {
		...def,
		withDocument(name: string, config: DocumentConfig) {
			return attachDocumentBuilder({
				...def,
				documents: {
					...def.documents,
					[name]: {
						guid: config.guid,
						onUpdate: config.onUpdate,
						awareness: config.awareness,
					},
				},
			});
		},
	} as T & {
		withDocument(name: string, config: DocumentConfig): T;
	};
}
