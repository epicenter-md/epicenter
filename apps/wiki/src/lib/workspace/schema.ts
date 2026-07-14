/**
 * Wiki schema: the two first-party tables and the shared types.
 *
 * The whole model is two ordinary `defineTable` schemas:
 *
 *   types   a registry of user-defined types. Each row IS a type: a stable id,
 *           a display name, an optional icon, and `columns` (the user's schema,
 *           stored as ColumnSpec[]). Materialized to `types/<id>.md`.
 *
 *   pages   the unit of the wiki. A worldview-neutral core (id, title,
 *           description?, tags[], source[], timestamps) plus ONE nested json
 *           cell `types` holding membership + values, keyed by type id, plus a
 *           `body` (the markdown body of the file). Membership IS key presence:
 *           a page is a `youtube_video` iff its `types` cell has that key.
 *
 * `body` is a plain string column on the row for this slice (routed to the
 * markdown file's body section by `./markdown.ts`, never into frontmatter). It
 * shares the row's whole-row LWW, the same trade every page already accepts.
 * Promote it to a per-row content `Y.Doc` (honeycrisp's note-body pattern)
 * when collaborative or independently-syncing body editing is real.
 */

import { field } from '@epicenter/field';
import {
	defineTable,
	type InferTableRow,
	nullable,
} from '@epicenter/workspace';
import { type TSchema, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonObject, JsonValue } from 'wellcrafted/json';

/** Stable id of a wiki page (the markdown file stem, the row key). */
export type PageId = string & Brand<'PageId'>;
/** Stable id of a user-defined type (a slug like `youtube_video`). */
export type TypeId = string & Brand<'TypeId'>;

/** A type id is a stable slug; it also becomes a SQL table-name segment. */
export const TYPE_ID_PATTERN = /^[a-z0-9_]+$/;

/** A field.* result is a non-null JSON object; a string/array/primitive is not. */
export function isTSchemaObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One column of a user-defined type.
 *
 * - `id` is the stable physical id. A rename never touches it, which is what
 *   makes a display rename metadata-only (no SQL DDL).
 * - `name` is the display name; free to change.
 * - `schema` is the column's TypeBox schema, authored with the real `field.*`
 *   builders (`field.url()`, `nullable(field.number())`) so call sites
 *   get autocomplete and type-checking. A `TSchema` IS JSON Schema, so it is
 *   stored verbatim and re-validated with `Value.Check` after the Yjs/JSON
 *   round-trip (this TypeBox validates on plain JSON Schema, no `[Kind]`
 *   symbols, so a round-tripped schema validates identically). NO eval, NO
 *   codegen, NO interpreter.
 */
export type ColumnSpec = {
	id: string;
	name: string;
	schema: TSchema;
};

/**
 * The `types.columns` JSON cell. `Type.Unsafe` pins TypeBox's static view to the
 * stored JSON shape; `field.json` remains the persisted storage declaration.
 */
type StoredColumnSpec = { id: string; name: string; schema: JsonObject };

const columnsCell = field.json(
	Type.Unsafe<StoredColumnSpec[]>(
		Type.Array(
			Type.Object({
				id: Type.String(),
				name: Type.String(),
				schema: Type.Unknown(),
			}),
		),
	),
);

/**
 * The `pages.types` cell: membership + values, keyed by type id then column id.
 *
 *   { youtube_video: { url: "https://...", duration: 1240 } }
 *
 * Like `columnsCell`, `Type.Unsafe` pins the exact nested-record static inside
 * the persisted `field.json` declaration.
 */
export type PageTypeValues = Record<string, Record<string, JsonValue>>;

const pageTypeValuesCell = field.json(
	Type.Unsafe<PageTypeValues>(
		Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
	),
);

/** The types registry: one row per user-defined type. */
export const typesTable = defineTable({
	id: field.string<TypeId>(),
	name: field.string(),
	icon: nullable(field.string()),
	columns: columnsCell,
	createdAt: field.datetime(),
	updatedAt: field.datetime(),
});

/** The pages table: worldview-neutral core + the nested `types` cell + body. */
export const pagesTable = defineTable({
	id: field.string<PageId>(),
	title: field.string(),
	description: nullable(field.string()),
	tags: field.json(Type.Array(Type.String())),
	source: field.json(Type.Array(Type.String())),
	types: pageTypeValuesCell,
	body: field.string(),
	createdAt: field.datetime(),
	updatedAt: field.datetime(),
});

export type WikiType = InferTableRow<typeof typesTable>;
export type Page = InferTableRow<typeof pagesTable>;

/**
 * Read a registry row's columns as authoring `ColumnSpec[]` (each `schema` a
 * `TSchema`). The single boundary where the stored JSON-object schema is read
 * back as a TypeBox schema; the runtime value is unchanged.
 */
export function typeColumns(type: WikiType): ColumnSpec[] {
	return type.columns as unknown as ColumnSpec[];
}

export const wikiTableDefinitions = {
	types: typesTable,
	pages: pagesTable,
};
