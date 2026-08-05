/**
 * One row, as the markdown file that stands for it.
 *
 * Frontmatter is the row's fields with its id in front; the body is the row
 * document. Nothing durable records this layout, so the filename, the key order,
 * and the rendering are all functions of the replica and changing any of them is
 * re-rendering rather than migrating (ADR-0207).
 */

import type { JsonObject, TableDefinition } from '@epicenter/lens';
import { serializeEntry } from '@epicenter/matter-core';

export type RenderInput = {
	id: string;
	fields: JsonObject;
	/** Ignored unless the table declared `body: 'text'`. */
	body?: string;
	definition: TableDefinition;
};

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
	body = '',
	definition,
}: RenderInput): string {
	const frontmatter: JsonObject = { id };
	for (const name of Object.keys(definition.fields)) {
		if (Object.hasOwn(fields, name)) frontmatter[name] = fields[name] as never;
	}
	return serializeEntry(frontmatter, definition.body === 'text' ? body : '');
}
