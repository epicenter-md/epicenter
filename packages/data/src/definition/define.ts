/**
 * The three authoring calls, and the refusals that shape their parameters.
 *
 * A declaration is checked twice: here, while it is being written, and again
 * in `compile.ts` when it is parsed. Both halves state the same rules, and the
 * runtime half is the one that catches a definition this file never saw.
 *
 * The refusals sit above the calls that apply them, and together rather than
 * one beside each rule, because the one that drifted did so alone:
 * `ValidateTable` dispatched on the key `fields` for a day after the
 * declaration renamed it to `scalars`. A conditional type answering "no" is a
 * legal answer, so nothing failed and nothing said anything. A stale key is
 * visible next to four siblings that are not.
 */
import type { TSchema } from 'typebox';

import { parseData } from './compile.js';
import type {
	DataDefinition,
	FieldMap,
	RowFileCodec,
	RowFileCodecOf,
} from './declaration.js';

type RejectDefault<T> = T extends { default: unknown } ? never : T;
type ValidateFields<T> = {
	[K in keyof T]: T[K] extends TSchema ? RejectDefault<T[K]> : never;
};
type ValidateTable<T> = {
	[K in keyof T]: K extends 'scalars'
		? T[K] extends FieldMap
			? ValidateFields<T[K]>
			: never
		: K extends 'types'
			? T[K] extends readonly string[]
				? // Not a shrug: a literal with no `scalars` key has nothing for a
					// type field to collide WITH, so passing it through is the answer
					// rather than the absence of one.
					T extends { scalars: infer TScalars extends FieldMap }
					? RejectScalarCollision<TScalars, T[K]>
					: T[K]
				: never
			: T[K];
};
type ValidateDefinition<T> = {
	[K in keyof T]: K extends 'tables'
		? { [N in keyof T[K]]: ValidateTable<T[K][N]> }
		: K extends 'kv'
			? T[K] extends FieldMap
				? ValidateFields<T[K]>
				: never
			: T[K];
};

/**
 * Refuse a type field that is already a scalar, at the name that collides.
 *
 * `RowOf` is `{ id } & ScalarsOf<T> & TypesOf<T>`, so one name in both buckets
 * intersects a `Static<>` with a `Y.Type` and the field reads as an impossible
 * type rather than as a mistake. `parseData` refuses it at runtime; this is the
 * compile-time half, and it belongs here because this is the authoring call.
 *
 * The bad element's expected type BECOMES the sentence, rather than the whole
 * declaration failing. That is what puts the error under `'title'` in `types`
 * and prints the reason, instead of reporting a mismatched object three lines
 * up. Intersecting with `TTypes` would collapse the element to `never` and take
 * the sentence with it.
 *
 * A homomorphic mapped type over `keyof TTypes`, so it stays an inference site:
 * `types: ['body']` still infers `readonly ['body']` rather than widening.
 *
 * A name declared twice WITHIN `types` is not caught here. Finding it means
 * accumulating what has been seen across the tuple, which is a search rather
 * than a lookup; `parseData` refuses that one, and it stays runtime.
 */
type RejectScalarCollision<
	TScalars extends FieldMap,
	TTypes extends readonly string[],
> = {
	[I in keyof TTypes]: TTypes[I] extends keyof TScalars
		? `'${TTypes[I] & string}' is already a scalar of this table, and one name cannot be both`
		: TTypes[I];
};

export function defineTable<
	const TScalars extends FieldMap,
	const TTypes extends readonly string[] = readonly [],
>(
	table: {
		scalars: TScalars & ValidateFields<TScalars>;
		types?: RejectScalarCollision<TScalars, TTypes>;
	} & ([TTypes[number]] extends [never]
		? { file?: RowFileCodecOf<{ scalars: TScalars; types: TTypes }> }
		: { file: RowFileCodecOf<{ scalars: TScalars; types: TTypes }> }),
): { scalars: TScalars; types: TTypes; file?: RowFileCodec } {
	return table as unknown as {
		scalars: TScalars;
		types: TTypes;
		file?: RowFileCodec;
	};
}

export function defineKv<const TFields extends FieldMap>(
	fields: TFields & ValidateFields<TFields>,
): TFields {
	return fields as TFields;
}

export function defineData<const TData extends DataDefinition>(
	data: TData & ValidateDefinition<TData>,
): TData {
	// Compile eagerly at the authoring call (ADR-0266): a malformed definition
	// fails here, as the programmer error it is, rather than at first open. The
	// compile is held beside this object, so an opener that later passes the same
	// definition is a cache hit and never recompiles.
	const compiled = parseData(data);
	if (compiled.error !== null) {
		throw new Error(compiled.error.message, { cause: compiled.error });
	}
	// **A table that declares any `field.type()` must declare `file`**
	// (ADR-0296), and this is the only place the rule can be enforced at
	// runtime. `parseData` cannot: it also reads a definition that arrived as
	// JSON, which cannot carry a function, so a codec's absence there says
	// nothing. This call is the authoring boundary, where a missing codec is a
	// programmer error and the last moment it is fixable rather than a body
	// missing from a backup.
	for (const [tableName, table] of compiled.data.tables) {
		if (table.types.length === 0 || table.file !== undefined) continue;
		throw new Error(
			`Table '${tableName}' declares type content (${table.types.join(
				', ',
			)}) and no file codec to export or import it with`,
		);
	}
	return data as TData;
}
