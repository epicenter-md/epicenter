/**
 * One markdown file, read back as a claim about a row.
 *
 * A claim, not a row: the file says what it believes, and nothing here decides
 * whether that belief lands. A claim carrying no id is a claim to create, which
 * is a positive signal rather than an accident, since the id is written back
 * into the file once it is minted (ADR-0207).
 *
 * Refusal is per file and never per push. No transaction spans rows, so a value
 * that is a valid YAML scalar but wrong for its declared field has nothing to do
 * with a valid claim on a different row.
 */

import {
	DATA_ADDRESS_CEILINGS,
	isRowId,
	type JsonObject,
} from '@epicenter/lens';
import {
	compileTableDefinition,
	type TableDefinition,
} from '@epicenter/lens/legacy';
import { parseMarkdown } from '@epicenter/matter-core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

export type RowClaim = {
	/** Absent when this file is claiming to create a row. */
	id: string | undefined;
	/** Includes the declared body field, read back from below the fence. */
	fields: JsonObject;
};

/** Why a file could not be read as a claim about a row. */
export const RefusedClaim = defineErrors({
	Unreadable: ({ reason }: { reason: string }) => ({
		message: `Cannot read the file: ${reason}`,
	}),
	InvalidId: ({ id }: { id: unknown }) => ({
		message: `Frontmatter 'id' is not a row id: ${JSON.stringify(id)}`,
	}),
	UnknownField: ({ field }: { field: string }) => ({
		message: `Unknown field '${field}' for this table`,
	}),
	BodyInFrontmatter: ({ field }: { field: string }) => ({
		message: `Field '${field}' is this table's body; write it below the frontmatter, not inside it`,
	}),
	InvalidField: ({ field }: { field: string }) => ({
		message: `Field '${field}' does not match its declared type`,
	}),
});
export type RefusedClaim = InferErrors<typeof RefusedClaim>;

/**
 * Read file text as a claim, checked against the table that owns it.
 *
 * Schema-directed rather than YAML-directed: the Lens already knows every
 * field's type, so a value is judged against its declaration instead of against
 * whatever YAML decided it looked like. That is what keeps a string field
 * holding `yes` a string.
 */
export function parseRow(
	text: string,
	definition: TableDefinition,
): Result<RowClaim, RefusedClaim> {
	const { data: file, error: parseError } = parseMarkdown(text);
	if (parseError) {
		return Err(RefusedClaim.Unreadable({ reason: parseError.message }).error);
	}

	const compiled = compileTableDefinition(definition);
	const { id: rawId, ...rest } = file.frontmatter;

	if (
		rawId !== undefined &&
		!(typeof rawId === 'string' && isRowId(rawId, DATA_ADDRESS_CEILINGS))
	) {
		return Err(RefusedClaim.InvalidId({ id: rawId }).error);
	}

	const fields: JsonObject = {};
	for (const [name, value] of Object.entries(rest)) {
		const field = compiled.fields.get(name);
		if (field === undefined) {
			return Err(RefusedClaim.UnknownField({ field: name }).error);
		}
		// The body belongs below the fence. Accepting it in both places would give
		// one value two homes and no rule for which wins.
		if (name === definition.body) {
			return Err(RefusedClaim.BodyInFrontmatter({ field: name }).error);
		}
		if (!field.check(value)) {
			return Err(RefusedClaim.InvalidField({ field: name }).error);
		}
		fields[name] = value as never;
	}

	if (definition.body !== undefined) {
		// An empty body clears an optional field rather than setting it to the
		// empty string, matching the nullish contract frontmatter already uses.
		const isOptional = compiled.optional.has(definition.body);
		if (file.body.length > 0 || !isOptional) {
			fields[definition.body] = file.body;
		}
	}

	return Ok({ id: rawId as string | undefined, fields });
}
