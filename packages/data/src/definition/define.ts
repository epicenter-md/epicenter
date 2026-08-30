/**
 * The two authoring calls, and the refusals that shape their parameters.
 *
 * A declaration is checked twice: here, while it is being written, and again
 * in `compile.ts` when it is parsed. The runtime half is the one that catches a
 * definition this file never saw, which is the only reason both exist.
 *
 * ONE DOOR. `defineTable` brands its return and `DataDefinition` requires the
 * brand, so every table is checked here and nowhere else. There used to be a
 * second path: a bare literal handed to `defineData`, re-checked by
 * `ValidateTable` and `ValidateDefinition`, which restated the same rules
 * through a different mechanism and could not report them as well. Both are
 * deleted. What is left validates `kv`, which is the one field map an
 * application still writes inline.
 *
 * That duplication is also what drifted: `ValidateTable` dispatched on the key
 * `fields` for a day after the declaration renamed it to `scalars`, and because
 * a conditional type answering "no" is a legal answer, nothing failed and
 * nothing said anything. A rule enforced in one place cannot go stale in the
 * other one.
 */
import { parseData } from './compile.js';
import type {
	DeclaredMark,
	DeclaredTable,
	FieldMap,
	RowFileCodec,
	RowFileCodecOf,
} from './declaration.js';

type RejectDefault<T> = T extends { default: unknown } ? never : T;
/**
 * The scalars of one bucket, with a declared default refused at the field.
 *
 * `defineTable` applies this to a table's `scalars` and `defineData` applies it
 * to `kv`, which are the two places a field map is authored. Nothing applies it
 * to a TABLE any more: a table reaches `defineData` already branded, so it has
 * been through `defineTable` and been checked there.
 */
type ValidateFields<T extends FieldMap> = {
	[K in keyof T]: RejectDefault<T[K]>;
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
): DeclaredMark & { scalars: TScalars; types: TTypes; file?: RowFileCodec } {
	// The brand is a phantom: declared, never assigned, and asserted here. The
	// cast that carries it is the same one that already erased `RowFileCodecOf`
	// down to `RowFileCodec`, so this adds an assertion rather than a hop.
	return table as unknown as DeclaredMark & {
		scalars: TScalars;
		types: TTypes;
		file?: RowFileCodec;
	};
}

export function defineData<
	const TData extends {
		readonly id: string;
		readonly title?: string;
		readonly kv: FieldMap;
		readonly tables: { readonly [table: string]: unknown };
	},
>(
	data: TData & {
		kv: ValidateFields<TData['kv']>;
		// Deferred on purpose. Naming `DeclaredTable` directly here would
		// contextually type every table literal with `types?: readonly string[]`,
		// and that context reaches INTO `defineTable`'s inference: a table with no
		// `types` would resolve `TTypes` to the constraint instead of the empty
		// default, and the codec rule would then demand a `file` for a table that
		// declares no type field. A conditional defers, so the brand is checked
		// without the shape being pushed inward.
		tables: {
			[N in keyof TData['tables']]: TData['tables'][N] extends DeclaredTable
				? TData['tables'][N]
				: DeclaredTable;
		};
	},
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
