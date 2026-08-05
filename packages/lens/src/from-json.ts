/**
 * Read a Lens that arrived as data rather than as a module.
 *
 * ADR-0168 decided a Lens is pure JSON whose whole semantics survive
 * `JSON.stringify` and `JSON.parse`, so that a host can load one *without
 * executing application source code* and validate it after download. This is the
 * function that finally takes it up: an installed application ships its Lens and
 * the host reads it (ADR-0210).
 *
 * There is deliberately no separate schema for this. `defineTable` and
 * `defineLens` already refuse every malformed shape (a field outside the
 * `field.*` vocabulary, a table name that is not a bare SQL identifier, a
 * case-insensitive duplicate, a body field that is not prose, a namespace that
 * is not reverse-domain), so they are the parser, and a second description of
 * the same grammar is how two spellings drift apart. All this adds is the
 * boundary that turns their throws into a value, because malformed input
 * arriving from disk is an expected outcome rather than a defect.
 */

import type { TSchema } from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import type { InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { defineLens, defineTable, type Lens } from './definitions.js';

export const LensJsonError = defineErrors({
	/** The value is not a Lens. `message` is the reason it is not. */
	InvalidLens: ({ message }: { message: string }) => ({ message }),
});
export type LensJsonError = InferErrors<typeof LensJsonError>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turn parsed JSON into a Lens, or say why it is not one.
 *
 * The tables are rebuilt through `defineTable` rather than passed straight
 * through, because a table definition is usable only once it has been compiled
 * and registered: an object that merely looks right is not one this runtime can
 * project a row with.
 */
export function lensFromJson(value: unknown): Result<Lens, LensJsonError> {
	if (!isPlainObject(value)) {
		return LensJsonError.InvalidLens({ message: 'A Lens must be a JSON object.' });
	}
	const { namespace, title, tables } = value;
	if (typeof namespace !== 'string') {
		return LensJsonError.InvalidLens({
			message: 'A Lens must declare a string namespace.',
		});
	}
	if (title !== undefined && typeof title !== 'string') {
		return LensJsonError.InvalidLens({
			message: "A Lens 'title' must be a string.",
		});
	}
	if (!isPlainObject(tables)) {
		return LensJsonError.InvalidLens({
			message: "A Lens must declare a 'tables' object.",
		});
	}

	try {
		const rebuilt: Record<string, ReturnType<typeof defineTable>> = {};
		for (const [name, definition] of Object.entries(tables)) {
			if (!isPlainObject(definition)) {
				return LensJsonError.InvalidLens({
					message: `Table '${name}' must be a JSON object.`,
				});
			}
			const { fields, body } = definition;
			if (!isPlainObject(fields)) {
				return LensJsonError.InvalidLens({
					message: `Table '${name}' must declare a 'fields' object.`,
				});
			}
			if (body !== undefined && typeof body !== 'string') {
				return LensJsonError.InvalidLens({
					message: `Table '${name}' has a 'body' that is not a field name.`,
				});
			}
			rebuilt[name] = defineTable({
				// Unvalidated until `defineTable` runs `recognize` over each entry,
				// which is where a value that is not a `field.*` schema is refused.
				fields: fields as Record<string, TSchema>,
				...(body === undefined ? {} : { body }),
			});
		}
		return Ok(defineLens({ namespace, title, tables: rebuilt }));
	} catch (cause) {
		// `defineTable` and `defineLens` throw one sentence naming what is wrong,
		// which is better than any taxonomy this boundary could invent.
		return LensJsonError.InvalidLens({ message: extractErrorMessage(cause) });
	}
}

/** Parse a Lens from its serialized form, refusing malformed JSON the same way. */
export function lensFromJsonText(text: string): Result<Lens, LensJsonError> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (cause) {
		return LensJsonError.InvalidLens({ message: extractErrorMessage(cause) });
	}
	return lensFromJson(parsed);
}
