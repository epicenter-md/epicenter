/**
 * `FlatJsonTSchema<S>`: the load-bearing type-level constraint for
 * `defineTable` columns.
 *
 * Applied per column inside `defineTable`'s generic via a mapped type:
 *
 *     defineTable<TCols>(v1: { [K in keyof TCols]: FlatJsonTSchema<TCols[K]> })
 *
 * The mapped type IS the parameter type. Do NOT intersect it with `TCols`:
 * intersecting `ColumnError<...>` (a string) with `TObject` (an object) yields
 * `never`, which surfaces the useless "not assignable to type 'never'" tooltip
 * instead of a readable English message at the offending field.
 *
 * On a valid column, `FlatJsonTSchema<S>` returns `S` unchanged. On an invalid
 * column, it returns a `ColumnError<'...message...'>` template-literal string
 * that the user's schema value cannot assign to: TypeScript surfaces the
 * message at the offending field with a clean tooltip.
 *
 * The discrimination happens in two stages:
 *
 * 1. **Structural**: match `S['~kind']` against the rejected-kind unions
 *    enumerated below, plus the `'~codec'` decoration that `Type.Transform`
 *    leaves on any inner schema.
 * 2. **Static<>**: fall back to `Static<S> extends JsonValue` so a
 *    `Type.Unsafe<Date>(...)` or `Type.Base<Date>` extension still gets
 *    caught when the user bypasses the structural check.
 */

import type { Static, TSchema } from 'typebox';
import type { JsonValue } from 'wellcrafted/json';

/**
 * Template-literal error type. The message IS the brand: do NOT intersect with
 * an object brand (TS renders "missing property X") and do NOT intersect with
 * a second string literal (`Msg & '​'` collapses to `never`). The trailing
 * U+200B (zero-width space) keeps the IDE tooltip readable while making the
 * type structurally distinct from any plain string a user could type.
 *
 * Mirrors the pattern in `packages/workspace/src/shared/actions.ts:209-210`
 * and `@ark/util`'s internal `ErrorMessage<M>`.
 */
export type ColumnError<Msg extends string> = `${Msg}​`;

// `Array` is intentionally NOT here: a list of scalars (`field.tags()` /
// `field.multiSelect()`) is a flat JSON-TEXT column, and the final `Static<S> extends
// JsonValue` clause still rejects a list of non-JSON elements (e.g. `Date[]`). A bare
// object / record / tuple / intersection still routes to `field.json(...)`.
type RejectedCompositeKind = 'Object' | 'Record' | 'Tuple' | 'Intersect';

type RejectedNonJsonKind = 'BigInt' | 'Symbol' | 'Undefined' | 'Void';

type RejectedNonStorableKind =
	| 'Function'
	| 'Constructor'
	| 'Promise'
	| 'Iterator'
	| 'AsyncIterator';

type RejectedTopKind = 'Any' | 'Unknown' | 'Never';

type RejectedRefKind = 'Ref' | 'This' | 'Cyclic';

type RejectedModifierKind = 'Optional' | 'Readonly';

/**
 * Two-stage flat-JSON column constraint.
 *
 * Returns `S` on success; on failure, returns a `ColumnError<'...'>` template
 * literal whose contents the IDE renders as an English sentence pointing at
 * the rejected column.
 */
export type FlatJsonTSchema<S extends TSchema> = S extends {
	'~codec': unknown;
}
	? ColumnError<'Type.Transform/Codec is not allowed in defineTable columns. Transforms are not portable and break SQLite materialization. Drop the transform or move it into the migrate function.'>
	: S extends { '~kind': infer K }
		? K extends RejectedCompositeKind
			? ColumnError<`Nested structures (~kind '${K & string}') cannot map to a single SQLite column. Wrap in field.json(schema) to store as JSON-encoded TEXT, or split into separate columns. (A list of scalars is fine: field.tags() / field.multiSelect().)`>
			: K extends RejectedNonJsonKind
				? ColumnError<`'${K & string}' is not JSON-serializable. Use field.string<Brand>() if you need a TEXT representation.`>
				: K extends RejectedNonStorableKind
					? ColumnError<`'${K & string}' is not a storable value. Compute at read time instead.`>
					: K extends RejectedTopKind
						? ColumnError<`'${K & string}' has no derivable storage class. Use field.json(schema) for a JSON-shaped escape hatch.`>
						: K extends RejectedRefKind
							? ColumnError<`Reference type '${K & string}' requires resolution and cannot live in a CRDT row. Use a branded string id (field.string<OtherRowId>()).`>
							: K extends RejectedModifierKind
								? ColumnError<`Modifier '${K & string}' is not allowed at the column level. Use nullable(inner) for intentionally-empty values; optional keys aren't safe in CRDT rows.`>
								: Static<S> extends JsonValue
									? S
									: ColumnError<'Column Static<> is not assignable to JsonValue. Common cause: Type.Unsafe<NonJsonValue>(...) (e.g. Type.Unsafe<Date>) or a Type.Base<Value> extension whose value type is Date / bigint / Uint8Array / undefined.'>
		: S;
