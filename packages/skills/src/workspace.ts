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

import type { DataView, RichField } from '@epicenter/data';
import {
	defineData,
	defineTable,
	field,
	type JsonValue,
	jsonValue,
	type RowOf,
} from '@epicenter/data/definition';
import { Ok } from 'wellcrafted/result';

const skillsTable = {
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
	/** The markdown a person edits: a nested `Y.Type` on the row (ADR-0295). */
	content: field.type(),
} as const;

const referencesTable = {
	skillId: field.string(),
	path: field.string(),
	updatedAt: field.instant(),
	/** The markdown a person edits: a nested `Y.Type` on the row (ADR-0295). */
	content: field.type(),
} as const;

/**
 * The file codec both tables share (ADR-0296).
 *
 * One codec, because both tables carry the same one kind of thing: the
 * markdown is the body and every declared scalar is frontmatter. It is written
 * once and passed twice rather than being a shape the platform infers, because
 * the mapping is the table's to own even when two tables happen to agree.
 */
const markdownFile = {
	serialize: ({
		id: _id,
		content,
		...fields
	}: { id: string; content: RichField } & Record<string, unknown>) => ({
		data: fields as Record<string, JsonValue>,
		content: content.toString(),
	}),
	deserialize: (
		file: { data: Record<string, unknown>; content: string },
		types: { content: RichField },
	) => {
		if (file.content !== '') types.content.insert(0, [file.content]);
		return Ok(file.data as never);
	},
};

export const skillsDefinition = defineData({
	id: 'so.epicenter.skills',
	title: 'Skills',
	kv: {},
	tables: {
		skills: defineTable({ fields: skillsTable, file: markdownFile }),
		skillReferences: defineTable({
			fields: referencesTable,
			file: markdownFile,
		}),
	},
});

/** The typed view of one store through the Skills workspace. */
export type SkillsData = DataView<typeof skillsDefinition>;

export type Skill = RowOf<typeof skillsTable>;
export type Reference = RowOf<typeof referencesTable>;

/**
 * The rich field a skill's instructions, or a reference's body, lives in.
 *
 * One name for both tables, because it is one kind of thing: the markdown a
 * person edits, kept out of the scalar row so it merges per character rather
 * than per write (ADR-0207). Minted with the row and never again (ADR-0295).
 */
export const SKILL_CONTENT = 'content';
