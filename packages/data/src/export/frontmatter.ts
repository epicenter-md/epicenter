/**
 * The frontmatter half of a row's export file (ADR-0268).
 *
 * One block of YAML above the body, carrying the row's raw stored fields. The
 * emitter is deliberately a subset of YAML chosen for exact round-trips:
 * every string is emitted as a JSON string (a valid YAML double-quoted
 * scalar), numbers, booleans, and null emit bare, and compound values emit as
 * JSON (valid YAML flow style). Nothing bare can ever be re-read as another
 * type, so `"007"` and `"no"` survive as the strings they are; the artifact
 * is lossy of history, never of a value (ADR-0267/0268).
 *
 * Keys are sorted, so two exports of one workspace diff line by line. A key
 * outside the declared field grammar (a value an older release wrote) is
 * emitted as a JSON-quoted key, which YAML also accepts.
 */
import type { JsonObject, JsonValue } from '../definition/index.js';

/** A key YAML takes unquoted without reinterpretation: the field grammar. */
const BARE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * One row's fields as a frontmatter block, `---` through `---`.
 *
 * Always present, even empty, so a file's body begins at one deterministic
 * place: after the closing delimiter and one blank separator line.
 */
export function frontmatter(fields: JsonObject): string {
	const lines = ['---'];
	for (const key of Object.keys(fields).sort()) {
		const name = BARE_KEY.test(key) ? key : JSON.stringify(key);
		lines.push(`${name}: ${yamlValue(fields[key])}`);
	}
	lines.push('---');
	return lines.join('\n');
}

function yamlValue(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return 'null';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	// Arrays and objects: JSON is valid YAML flow style, and exact.
	return JSON.stringify(value);
}

/**
 * One row's whole export file: frontmatter, and the body when there is one.
 *
 * A blank line separates the block from the body for legibility; a row with
 * no body (a table without a document block, or a codec that serialized the
 * empty document to nothing) is the frontmatter block alone.
 */
export function rowFile(fields: JsonObject, body: string | undefined): string {
	const block = frontmatter(fields);
	if (body === undefined || body === '') return `${block}\n`;
	return `${block}\n\n${body}\n`;
}
