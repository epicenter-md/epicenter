/**
 * One row, as the markdown file that stands for it.
 *
 * Frontmatter is the row's fields with its id in front. If the table declared a
 * body, that one field is written below the fence instead of inside it, because
 * prose reads badly as a quoted YAML scalar and is the thing a person actually
 * opens the file to change (ADR-0207).
 *
 * Nothing durable records this layout, so the filename, the key order, and the
 * placement of the body are all functions of the replica, and changing any of
 * them is re-rendering rather than migrating.
 */

import type { JsonObject, TableDefinition } from '@epicenter/lens';
import { serializeEntry } from '@epicenter/matter-core';

/**
 * Render a row to file text.
 *
 * Field order follows the table declaration rather than whatever order the row's
 * JSON happens to hold, because an unstable key order would rewrite every file
 * on every render and make `status` unreadable. The id leads, since it is the
 * one key a reader needs to find first and the only one that binds.
 */
export function renderRow({
	id,
	fields,
	definition,
}: {
	id: string;
	fields: JsonObject;
	definition: TableDefinition;
}): string {
	const frontmatter: JsonObject = { id };
	for (const name of Object.keys(definition.fields)) {
		if (name === definition.body) continue;
		// An unset optional field is absent, never `key: null`, matching the nullish
		// contract the frontmatter serializer already keeps. A field genuinely
		// holding `null` is a value and survives.
		const value = fields[name];
		if (value !== undefined) frontmatter[name] = value;
	}

	const body =
		definition.body === undefined ? '' : (fields[definition.body] ?? '');
	return serializeEntry(frontmatter, typeof body === 'string' ? body : '');
}
