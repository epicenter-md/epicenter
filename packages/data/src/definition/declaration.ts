/**
 * What an application declares, and what that declaration reads as.
 *
 * All vocabulary and no behaviour. A definition names two buckets per table
 * and a bag of settings beside them; the lens at the bottom turns that
 * declaration into the types an application writes.
 *
 * Every type here is a LOOKUP. None asks whether its argument is a
 * declaration, because the parameter says so, and none can answer `never` for
 * "I could not tell". A definition that arrived as JSON never comes through
 * here: it reaches `parseData` as `unknown` and is checked in `compile.ts`.
 */
import {
	type Field,
	field as genericField,
	type storageOf,
} from '@epicenter/field';
import type * as Y from '@y/y';
import { type Static, type TSchema, Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { JsonValue } from './json.js';

export const RESERVED_ATTRIBUTE_PREFIX = '!';
export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/**
 * The fields of one bucket, by name.
 *
 * A field IS a schema. It was `object` for one release, so that this one type
 * could describe both a declaration written with `field.*` and one that arrived
 * as JSON, and every type reading a declaration paid for it: unable to assume a
 * schema, each asked `extends TSchema` and answered `never` when the guess
 * failed. A wrong answer, silently, rather than an error.
 *
 * Nothing needed it. A definition read from JSON reaches `parseData` as
 * `unknown` and is validated there (`apps/epicenter/src/static-assets.ts` is
 * the one caller that does it), so the serialized shape never had a static
 * form to accommodate. What is declared here is what an author writes.
 */
export type FieldMap = {
	readonly [field: string]: TSchema;
};

/** One row's export file, split at the fence (ADR-0296). */
export type RowFile = {
	/** The frontmatter, parsed. */
	readonly data: Record<string, JsonValue>;
	/** Everything below the fence. */
	readonly content: string;
};

export const RowFileError = defineErrors({
	/**
	 * A table's own `deserialize` refused this file.
	 *
	 * The codec's error arm, returned rather than thrown, because a folder a
	 * person hands to an import is data rather than a programmer error and the
	 * import that reads it reports which file it could not read.
	 */
	Unreadable: ({ reason, cause }: { reason: string; cause?: unknown }) => ({
		message: `This file could not be read into a row: ${reason}`,
		reason,
		cause,
	}),
});
export type RowFileError = InferErrors<typeof RowFileError>;

/**
 * A table's bidirectional file codec, erased of its declaration (ADR-0296).
 *
 * The platform owns the file FORMAT: it splits the fence, parses the
 * frontmatter into a record, and joins it back. The table owns the MAPPING,
 * which is this.
 *
 * **The two are inverses.** `serialize` takes a whole row and returns a file;
 * `deserialize` takes a file and returns a whole row, type fields included and
 * already built. `create` integrates them in the transaction that mints the
 * row (ADR-0296, amended).
 *
 * It was not always symmetric. `deserialize` used to be handed types the
 * platform had already minted and attached, and fill them in place, because
 * ADR-0296 measured a detached `Y.Type` as unable to survive many writes. The
 * mechanism it named is real and the conclusion was too broad: a detached type
 * is safe for one bulk operation and for attribute writes, which is what every
 * codec here does and what `pmToFragment` produces, and unsafe only for a loop
 * of positional appends. `RowFileCodec` carries the rule and
 * `evidence/detached-type.test.ts` pins it.
 *
 * A returned type must be fresh. Two rows given one type share one body,
 * silently, so `createRow` refuses one that already belongs to a document.
 */
export type RowFileCodec = {
	readonly serialize: (row: RowValues) => RowFile;
	readonly deserialize: (
		file: RowFile,
	) => Result<Record<string, JsonValue | Y.Type>, RowFileError>;
};

/** One row as a codec sees it: its id, its scalars, and its nested types. */
export type RowValues = {
	readonly id: string;
} & Readonly<Record<string, JsonValue | Y.Type>>;

/**
 * One table's declaration, as the inert definition carries it.
 *
 * TWO BUCKETS. A scalar holds a JSON value: replaced whole on write, last write
 * wins. A type field holds a live `Y.Type`: edited in place, merging
 * internally. They are different in every operation, so the declaration says
 * so rather than hiding it in a marker for the type system to rediscover.
 */
export type TableDeclaration = {
	/** The fields holding a JSON value. */
	readonly scalars: FieldMap;
	/**
	 * The fields holding a live `Y.Type`, by name.
	 *
	 * Names and nothing else, because there is nothing to configure: a type
	 * field has no schema, no nullability and no format. It used to be declared
	 * with `field.type()`, a descriptor whose entire content was a marker
	 * saying "I am not a descriptor", and what that marker smuggled through the
	 * scalars was this list.
	 */
	readonly types?: readonly string[];
	readonly file?: RowFileCodec;
};

/**
 * The mark `defineTable` leaves, and the only way to get one.
 *
 * A table declaration is a plain object, so any literal of the right shape used
 * to satisfy `DataDefinition`. That made two authoring paths for one thing:
 * `defineTable`, which checks its parameter, and a bare literal handed to
 * `defineData`, which needed a second set of conditional types to re-check the
 * same rules and could not report them as well. Every rule was written twice
 * and one of the copies silently stopped applying for a day.
 *
 * Nominal, so there is one door. Nothing constructs this value: the brand is
 * declared and never assigned, and `defineTable`'s return asserts it.
 */
declare const DECLARED: unique symbol;

/**
 * The mark alone, without the shape.
 *
 * `defineTable` returns this intersected with the LITERAL types it inferred,
 * never with `TableDeclaration`. Intersecting the wide form in would drag its
 * index signature along, and `ScalarsOf` mapping over
 * `keyof (FieldMap & { title: TString })` reads the index member too and
 * resolves every row field to `unknown`.
 */
export type DeclaredMark = { readonly [DECLARED]: true };

/** A table declaration that went through `defineTable`. */
export type DeclaredTable = TableDeclaration & DeclaredMark;

/** One application's complete, inert data definition. */
export type DataDefinition = {
	readonly id: string;
	readonly title?: string;
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: DeclaredTable;
	};
};

/**
 * Add data-substrate nullability without teaching the generic field package
 * about it.
 *
 * `Type.Union` with `Type.Null`, which is TypeBox's own spelling of exactly
 * this. It emits the same `anyOf: [inner, { type: 'null' }]` the hand-rolled
 * version did, byte for byte, and infers `Static<S> | null` including for a
 * BRANDED inner schema, which is the case that made this a function in the
 * first place.
 *
 * It used to be built with `Type.Unsafe` and two casts, because a schema
 * assembled that way leaves its `Static` to be recovered structurally from the
 * `anyOf` and that recovery produced `unknown` for a branded `TUnsafe`:
 * `field.nullable(field.string())` read as `string | null` while
 * `field.nullable(field.instant())` read as `unknown`, in the same table. That
 * is a real defect in structural recovery and it is not a reason to reach for
 * the escape hatch, because `Type.Union` never had it.
 *
 * The old return type also carried `& { anyOf: readonly [S, …] }` so the shape
 * could be read back at the type level. Nothing ever read it: `nullableParts`
 * recognizes a nullable field at RUNTIME, off an untyped record.
 */
function nullable<S extends TSchema>(inner: S) {
	return Type.Union([inner, Type.Null()]);
}

/** The data definition's field namespace. */
export const field = Object.freeze({
	...genericField,
	nullable,
});

export type DataField = {
	readonly name: string;
	readonly kind: Field['kind'];
	readonly schema: unknown;
	readonly check: (value: unknown) => boolean;
	readonly nullable: boolean;
	readonly storage: ReturnType<typeof storageOf>;
	readonly reference: string | null;
};

/** What one bucket's fields read as, once the schemas are resolved. */
type FieldsOut<TFields extends FieldMap> = {
	[K in keyof TFields]: Static<TFields[K]>;
};

/**
 * One table's type fields: the live `Y.Type` at each declared name.
 *
 * A lookup, not a filter. The declaration already lists them, and a table that
 * declares none lists nothing: `NonNullable` covers the absent key without a
 * conditional, because absent and empty are the same answer here.
 */
export type TypesOf<T extends TableDeclaration> = {
	[K in NonNullable<T['types']>[number]]: Y.Type;
};

/**
 * One table's scalar fields: what `update` may patch, what `deserialize`
 * returns beside the types it built, and what a codec writes to frontmatter.
 *
 * A type field is absent because a type is not assignable: writing one over a
 * row's attribute deletes the old subtree, so a peer that edited it
 * concurrently loses every keystroke to map LWW. That rule is why this type
 * exists, and stating it as a signature is what keeps it from being a comment
 * somebody has to obey.
 */
export type ScalarsOf<T extends TableDeclaration> = FieldsOut<T['scalars']>;

/**
 * One table's read shape: the id, the scalars, and the live types.
 *
 * What `get` returns, what `create` returns, and what a file codec's
 * `serialize` takes. It was scalars only, with `content(rowId)` as the one way
 * to a type field and `RowOf` as a third shape for the codec; the row
 * carries its types now, so all three collapse into this (ADR-0296, amended).
 *
 * `NewRowOf` is this minus the id and with the types optional. That sentence is
 * the whole relationship between the two shapes an application ever names.
 */
export type RowOf<T extends TableDeclaration> = { id: string } & ScalarsOf<T> &
	TypesOf<T>;
/**
 * A row that does not have an id yet: the scalars, and the type types the
 * caller built (ADR-0295, ADR-0296).
 *
 * What `create` takes and what `deserialize` returns, which is one shape
 * because they are one operation with two input formats. A type field is
 * PASSED IN, already populated, and `create` integrates it in the transaction
 * that mints the row.
 *
 * That is a reversal of ADR-0296, which had the platform mint and attach the
 * types first. **How you fill the type you pass matters**: one bulk operation
 * or attribute writes are safe, a loop of positional appends silently reverses,
 * and it reads as empty until `create` integrates it. `RowFileCodec` states the
 * rule and `evidence/detached-type.test.ts` pins it.
 *
 * A type handed here must not already belong to a document. Two rows given one
 * type SHARE one body, silently, and the same type set into two documents
 * corrupts across them; `createRow` refuses an integrated type rather than
 * letting either happen.
 *
 * Type fields are OPTIONAL, and that is what keeps a programmatic `create`
 * from having to build an empty body it does not care about: an omitted one is
 * minted empty. A codec that means to leave a body empty says so the same way.
 */
export type NewRowOf<T extends TableDeclaration> = ScalarsOf<T> &
	Partial<TypesOf<T>>;
export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;

/** The codec as its own table declares it, read through that table's fields. */
export type RowFileCodecOf<TFields extends TableDeclaration> = {
	readonly serialize: (row: RowOf<TFields>) => RowFile;
	readonly deserialize: (
		file: RowFile,
	) => Result<NewRowOf<TFields>, RowFileError>;
};

/**
 * Declare one table.
 *
 * **A table that declares any `field.type()` must declare `file`** (ADR-0296),
 * and the parameter type is where that is enforced, because this is the
 * authoring call and a definition that arrived serialized has no codec to
 * declare. A type field with no codec would export a body that silently
 * vanishes, so the artifact directions refuse it as data loss rather than
 * writing an empty file.
 *
 * The return ERASES the codec's types, and the cast is what that costs. A
 * `DataDefinition` holds every table under one shape, so it cannot be generic
 * over each table's fields; `RowFileCodecOf<TFields>` narrows `serialize`'s
 * parameter, and a narrowed parameter is not assignable to a wider one. The
 * typing that matters happens here, at the authoring call, and the store reads
 * the erased form.
 */
