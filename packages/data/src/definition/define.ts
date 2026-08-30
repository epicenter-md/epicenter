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
	ContentCodec,
	DeclaredMark,
	DeclaredTable,
	FieldMap,
	ReservedRowField,
} from './declaration.js';

type RejectDefault<T> = T extends { default: unknown } ? never : T;

/**
 * The scalars of one bucket, with a declared default refused at the field and
 * a reserved name refused at the key.
 *
 * `defineTable` applies this to a table's `scalars` and `defineData` applies it
 * to `kv`, which are the two places a field map is authored.
 *
 * The reserved-name arm is what replaced a mapped type over the type-field
 * TUPLE that carried its error sentence in the element position. A row has one
 * node, at one reserved key, so a collision is a key comparison rather than a
 * search, and the message lands on the offending field.
 */
type ValidateFields<T extends FieldMap> = {
	[K in keyof T]: K extends ReservedRowField
		? `'${K & string}' is reserved: every row already has an id and a content node`
		: RejectDefault<T[K]>;
};

/**
 * Declare one table.
 *
 * **Every table declares its content codec**, because the platform cannot know
 * what a table's node means and there is no safe default: rendering a node as
 * text and reading the rendering back turns attributes into one literal string
 * that prints identically. A table whose content is exactly its text says
 * `plainText()`; a table whose node means something else says so itself.
 *
 * The return ERASES the codec down to `ContentCodec`, which costs nothing now
 * that a codec is a pair over one node rather than over a row. A
 * `DataDefinition` holds every table under one shape, so it cannot be generic
 * over each table's fields.
 */
export function defineTable<const TScalars extends FieldMap>(table: {
	scalars: TScalars & ValidateFields<TScalars>;
	content: ContentCodec;
}): DeclaredMark & { scalars: TScalars; content: ContentCodec } {
	// The brand is a phantom: declared, never assigned, and asserted here.
	return table as unknown as DeclaredMark & {
		scalars: TScalars;
		content: ContentCodec;
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
	return data as TData;
}
