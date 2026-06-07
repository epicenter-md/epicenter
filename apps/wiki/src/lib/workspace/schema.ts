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
 * Promote it to a per-row content `Y.Doc` (fuji's entry-body pattern) when
 * collaborative or independently-syncing body editing is real.
 */

import { defineTable, type InferTableRow, nullable } from '@epicenter/workspace';
import { field } from '@epicenter/field';
import { type TSchema, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonObject, JsonValue } from 'wellcrafted/json';

/** Stable id of a wiki page (the markdown file stem, the row key). */
export type PageId = string & Brand<'PageId'>;
/** Stable id of a user-defined type (a slug like `youtube_video`). */
export type TypeId = string & Brand<'TypeId'>;

export const asPageId = (value: string): PageId => value as PageId;

/** A type id is a stable slug; it also becomes a SQL table-name segment. */
export const TYPE_ID_PATTERN = /^[a-z0-9_]+$/;

/** A column.* result is a non-null JSON object; a string/array/primitive is not. */
export function isTSchemaObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One column of a user-defined type.
 *
 * - `id` is the stable physical id. A rename never touches it, which is what
 *   makes a display rename metadata-only (no SQL DDL).
 * - `name` is the display name; free to change.
 * - `schema` is the column's TypeBox schema, authored with the real `column.*`
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
 * The `types.columns` cell.
 *
 * A `TSchema` IS a JSON object at runtime, but TypeBox's `TSchema` static type
 * is not seen as `JsonValue`, so `defineTable`'s SQLite-safe gate would reject a
 * `schema: TSchema` field. The cell therefore stores `schema` as a JSON object
 * and `typeColumns()` reads it back as a `ColumnSpec` (schema as `TSchema`).
 * The runtime value is the same object either way.
 */
type StoredColumnSpec = { id: string; name: string; schema: JsonObject };

const columnsCell = Type.Unsafe<StoredColumnSpec[]>(
	Type.Array(
		Type.Object({
			id: Type.String(),
			name: Type.String(),
			schema: Type.Unknown(),
		}),
	),
);

/**
 * The `pages.types` cell: membership + values, keyed by type id then column id.
 *
 *   { youtube_video: { url: "https://...", duration: 1240 } }
 *
 * Like `columnsCell`, this uses `Type.Unsafe` rather than `field.json`: the
 * exact `Record<string, Record<string, JsonValue>>` static carries through while
 * the runtime schema stays an `object` the SQLite layer maps to a TEXT cell. Do
 * not "simplify" it back to `field.json`; the nested-record static does not
 * survive that gate.
 */
export type PageTypeValues = Record<string, Record<string, JsonValue>>;

const pageTypeValuesCell = Type.Unsafe<PageTypeValues>(
	Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
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
