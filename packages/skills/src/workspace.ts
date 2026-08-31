/**
 * Skills' inert data definition: the definition id it owns and the two
 * tables in it.
 *
 * A data definition is pure JSON (ADR-0213, ADR-0240): closed field
 * descriptors, and nothing that knows about storage, sync, or
 * documents. The `skills` and `skillReferences` property names are the durable
 * table names, so they are what row addresses carry and what the projection's
 * relations are called.
 *
 * Structural row ids are minted by the store. `sourceId` is the portable
 * agentskills.io identity kept in SKILL.md frontmatter; it may be used to match
 * a later import, and it never becomes record identity.
 */

import type { DataView } from '@epicenter/data';
import {
	defineData,
	defineTable,
	type FieldMap,
	field,
	type JsonValue,
	jsonValue,
	type NewRowOf,
	type RowFileCodecOf,
	type RowOf,
} from '@epicenter/data/definition';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';

const skillsTable = {
	scalars: {
		sourceId: field.string(),
		name: field.string(),
		description: field.string(),
		// Nullable rather than optional. A data definition has no optional
		// fields on purpose: a field has to be one type through the CRDT attribute,
		// the projection column and the row alike, and "absent" is not a SQL type.
		license: field.nullable(field.string()),
		compatibility: field.nullable(field.string()),
		// Opaque passthrough: whatever the frontmatter carried besides the fields
		// above, round-tripped on export. `unknown` values rather than a recursive
		// JSON type because the store's write gate already refuses anything that is
		// not finite JSON, and a second declaration of that rule would be the one
		// that goes stale.
		metadata: field.nullable(field.json(jsonValue)),
		allowedTools: field.nullable(field.string()),
		// Validation-only rather than `string.date.parse`: a parsing form would hand
		// back a `Date` that could not round-trip through the projection.
		updatedAt: field.instant(),
	},
	/** The markdown a person edits: a live `Y.Type` on the row (ADR-0295). */
	types: ['body'],
} as const;

const referencesTable = {
	scalars: {
		skillId: field.string(),
		path: field.string(),
		updatedAt: field.instant(),
	},
	/** The markdown a person edits: a live `Y.Type` on the row (ADR-0295). */
	types: ['body'],
} as const;

/**
 * The file codec both tables share (ADR-0296).
 *
 * One codec, because both tables carry the same one kind of thing: the
 * markdown is the body and every declared scalar is frontmatter. It is written
 * once and applied twice rather than being a shape the platform infers, because
 * the mapping is the table's to own even when two tables happen to agree.
 *
 * A function of the table's fields rather than one object, so each table gets a
 * codec typed against its OWN declaration. The two tables declare different
 * scalars, so a single object could not be typed as either and the assignment
 * was silenced with `as never` at both call sites. There is still one cast, but
 * it is here, once, and it names what it asserts.
 */
const markdownFile = <TFields extends FieldMap>(): RowFileCodecOf<TFields> => ({
	serialize: ({ id: _id, body, ...fields }) => ({
		data: fields as Record<string, JsonValue>,
		content: (body as Y.Type).toString(),
	}),
	deserialize: (file) => {
		// Built here and handed back (ADR-0296, amended). Fresh per row: two rows
		// given one type would share one body. One `insert` rather than a loop:
		// a detached type replays one positional delta, so appends would reverse.
		const body = new Y.Type();
		if (file.content !== '') body.insert(0, [file.content]);
		// Frontmatter is `unknown` and the declaration says what a scalar is;
		// nothing here can reconcile them, and nothing should. A value this
		// release cannot read is reported as nonconforming on the first read
		// rather than refused at the door (ADR-0125), which is what keeps an
		// artifact readable by the release that has to fix it.
		return Ok({ ...file.data, body } as NewRowOf<TFields>);
	},
});

export const skillsDefinition = defineData({
	id: 'so.epicenter.skills',
	title: 'Skills',
	kv: {},
	tables: {
		skills: defineTable({
			...skillsTable,
			file: markdownFile<typeof skillsTable>(),
		}),
		skillReferences: defineTable({
			...referencesTable,
			file: markdownFile<typeof referencesTable>(),
		}),
	},
});

/** The typed view of one store through the Skills workspace. */
export type SkillsData = DataView<typeof skillsDefinition>;

export type Skill = RowOf<typeof skillsTable>;
export type Reference = RowOf<typeof referencesTable>;
