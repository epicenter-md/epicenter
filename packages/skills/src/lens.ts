/**
 * Skills' inert Lens: the namespace it owns and the two tables in it.
 *
 * A Lens is pure JSON (ADR-0213): arktype expressions for the fields, and
 * nothing that knows about storage, sync, or documents. The `skills` and
 * `skillReferences` property names are the durable table names, so they are
 * what row addresses carry and what the projection's relations are called.
 *
 * Structural row ids are minted by the store. `sourceId` is the portable
 * agentskills.io identity kept in SKILL.md frontmatter; it may be used to match
 * a later import, and it never becomes record identity.
 */

import type { LensView } from '@epicenter/data';
import { defineLens, type RowOf } from '@epicenter/lens';

const skillsTable = {
	sourceId: 'string',
	name: 'string',
	description: 'string',
	// Nullable with a default rather than optional. A Lens has no optional
	// fields on purpose: a field has to be one type through the CRDT attribute,
	// the projection column and the row alike, and "absent" is not a SQL type.
	license: 'string|null = null',
	compatibility: 'string|null = null',
	// Opaque passthrough: whatever the frontmatter carried besides the fields
	// above, round-tripped on export. `unknown` values rather than a recursive
	// JSON type because the store's write gate already refuses anything that is
	// not finite JSON, and a second declaration of that rule would be the one
	// that goes stale.
	metadata: 'Record<string, unknown>|null = null',
	allowedTools: 'string|null = null',
	// Validation-only rather than `string.date.parse`: a parsing form would hand
	// back a `Date` that could not round-trip through the projection.
	updatedAt: 'string.date.iso',
} as const;

const referencesTable = {
	skillId: 'string',
	path: 'string',
	updatedAt: 'string.date.iso',
} as const;

export const skillsLens = defineLens({
	namespace: 'so.epicenter.skills',
	title: 'Skills',
	tables: { skills: skillsTable, skillReferences: referencesTable },
});

/** The typed view of one store through the Skills Lens. */
export type SkillsData = LensView<typeof skillsLens>;

export type Skill = RowOf<typeof skillsTable>;
export type Reference = RowOf<typeof referencesTable>;

/**
 * The root a skill's instructions, or a reference's body, lives at inside that
 * row's own document.
 *
 * One name for both tables, because it is one kind of thing: the markdown a
 * person edits, kept out of the row so it merges per character rather than
 * per write (ADR-0207).
 *
 * Named at `create` rather than felt for on first open, and that is a
 * correctness requirement rather than tidiness. `document(id).get(name)`
 * creates on miss, and a created nested type is addressed by the operation that
 * made it, so two devices first-opening one skill would each mint a root here
 * and map LWW would discard one along with everything written into it
 * (ADR-0215).
 */
export const SKILL_CONTENT = 'content';
