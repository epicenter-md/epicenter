/**
 * `defineTable(...)` — TypeBox-native table definition.
 *
 * Every column schema flows through the `FlatJsonTSchema` mapped-type
 * constraint, which rejects every TypeBox `~kind` that cannot materialize
 * 1:1 to a SQLite column. Users may construct columns via `column.X()` or
 * raw `Type.X()` interchangeably; the constraint enforces safety either way.
 *
 * `_v` is library-managed. Users never declare it as a column, never type
 * it at write sites, and never see it on returned rows. The library stamps
 * the current version onto each stored row, reads it for schema routing on
 * load, and strips it before handing the row back to the caller.
 *
 * Version numbers are positional: the first argument is v1, the second is
 * v2, etc. The migrate function receives `{ value, version }` and returns
 * the latest row shape; `switch (version)` narrows `value` to the matching
 * version's columns.
 *
 * @example
 * ```ts
 * // Single-version table: no migrate needed.
 * const notes = defineTable({
 *   id: field.string<NoteId>(),
 *   title: field.string({ minLength: 1, maxLength: 200 }),
 *   createdAt: field.datetime(),
 * });
 *
 * // Multi-version table: migrate is required.
 * const versioned = defineTable(
 *   // v1
 *   { id: field.string<NoteId>(), title: field.string() },
 *   // v2
 *   { id: field.string<NoteId>(), title: field.string(), pinned: field.boolean() },
 * ).migrate(({ value, version }) => {
 *   switch (version) {
 *     case 1: return { ...value, pinned: false };
 *     case 2: return value;
 *   }
 * });
 * ```
 */

import type { ColumnError, FlatJsonTSchema } from './column/constraint';
import {
	createTableDefinition,
	type LastVersion,
	type MigrateInput,
	type RowOf,
	type TableDefinition,
	type VersionedColumns,
} from './table';

/**
 * Refuse `_v` as a user-declared column key. The library stamps `_v` itself
 * on every write and strips it from every read; declaring it in columns
 * either silently fights the library or accidentally desyncs the schema.
 */
type RefuseV<TCols> = '_v' extends keyof TCols
	? ColumnError<'_v is library-managed; remove it from the column record'>
	: TCols;

/**
 * Apply `FlatJsonTSchema` per column. Used DIRECTLY as `defineTable`'s
 * parameter type (never intersected with `TCols`), so column-level errors
 * surface as readable English tooltips at the offending field rather than
 * collapsing to `never`.
 */
type ConstrainColumns<TCols extends VersionedColumns> = RefuseV<TCols> & {
	[K in keyof TCols]: FlatJsonTSchema<TCols[K]>;
};

type ConstrainVersions<TVersions extends readonly VersionedColumns[]> = {
	[I in keyof TVersions]: TVersions[I] extends VersionedColumns
		? ConstrainColumns<TVersions[I]>
		: never;
};

/**
 * Intermediate builder returned by the variadic overload until `.migrate(fn)`
 * is supplied. Intentionally NOT assignable to `TableDefinition`, so
 * attaching the unfinished builder to a Y.Doc is a compile error.
 */
type MigrationRequired<TVersions extends readonly VersionedColumns[]> = {
	migrate(
		fn: (input: MigrateInput<TVersions>) => RowOf<LastVersion<TVersions>>,
	): TableDefinition<TVersions>;
};

// Single-version overload: no migrate step needed.
export function defineTable<const TCols extends VersionedColumns>(
	v1: ConstrainColumns<TCols>,
): TableDefinition<[TCols]>;

// Multi-version overload: migrate is required before the definition is usable.
export function defineTable<
	const TVersions extends readonly [
		VersionedColumns,
		VersionedColumns,
		...VersionedColumns[],
	],
>(...versions: ConstrainVersions<TVersions>): MigrationRequired<TVersions>;

export function defineTable(
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly; overloads constrain caller-visible shape
	...args: any[]
	// biome-ignore lint/suspicious/noExplicitAny: see above
): any {
	if (args.length === 0) {
		throw new Error('defineTable() requires at least one schema argument');
	}

	const versions = args as readonly VersionedColumns[];

	if (versions.length === 1) {
		const onlyColumns = versions[0]!;
		return createTableDefinition(
			[onlyColumns] as const,
			(input) =>
				(input as { value: RowOf<VersionedColumns> }).value as RowOf<
					typeof onlyColumns
				>,
		);
	}

	return {
		migrate(fn: (input: unknown) => unknown) {
			return createTableDefinition(
				versions,
				fn as (input: unknown) => RowOf<VersionedColumns>,
			);
		},
	};
}
