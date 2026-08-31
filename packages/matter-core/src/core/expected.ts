/**
 * "What did this field expect" as a pure projection of a loaded {@link Field}.
 *
 * `integrity` classifies an out-of-domain value as `invalid` and carries the raw value plus the
 * {@link Field}; it never says what the field WANTED, because that is a projection, not a stored
 * fact. This module is that projection, in two pure steps over one shape:
 *
 *   - {@link describeExpected}: `Field` -> a small, serializable {@link ExpectedValue} (a kind,
 *     plus the allowed values for the enum kinds). The JSON edge: it rides in `--json`.
 *   - {@link formatExpected}: `ExpectedValue` -> the phrase a user reads ("one of a, b"). The text
 *     edge, shared by the CLI report and the in-app integrity panel.
 *
 * Both are pure functions of the field and import no UI framework, so they live in `core` beside
 * the model they describe and BOTH the CLI and the app read them from here. Each runs at the edge,
 * when a violation is formatted or serialized, never stored in the integrity model.
 */

import type { Field, Kind } from '../field/index.js';

/**
 * The serializable description of a field's accepted value. Every kind reduces to its `kind`
 * name except `select` / `multiSelect`, whose meaning IS their allowed value set, so those two
 * carry the enum members. This is the shape that rides in the `--json` output and feeds
 * {@link formatExpected}; it holds no validator, schema, or function, so it round-trips cleanly.
 */
export type ExpectedValue =
	| { kind: Exclude<Kind, 'select' | 'multiSelect'> }
	| { kind: 'select'; values: unknown[] }
	| { kind: 'multiSelect'; values: unknown[] };

/**
 * Project a loaded {@link Field} into its {@link ExpectedValue}. The `select` / `multiSelect`
 * cases lift the enum members off the typed schema (no cast: `field.kind` narrows `schema` to
 * the matching meta); every other kind is fully described by its name alone. Computed at the
 * report edge from the field a violation carries, never stored in the integrity model.
 */
export function describeExpected(field: Field): ExpectedValue {
	switch (field.kind) {
		case 'select':
			return { kind: 'select', values: [...field.schema.enum] };
		case 'multiSelect':
			return { kind: 'multiSelect', values: [...field.schema.items.enum] };
		case 'string':
		case 'url':
		case 'date':
		case 'instant':
		case 'datetime':
		case 'integer':
		case 'number':
		case 'boolean':
		case 'tags':
		case 'json':
		case 'reference':
			return { kind: field.kind };
		default:
			return field satisfies never;
	}
}

function valuesText(values: readonly unknown[]): string {
	return values.map((value) => String(value)).join(', ');
}

/** Turn the serializable {@link ExpectedValue} into the phrase a user reads. */
export function formatExpected(expected: ExpectedValue): string {
	switch (expected.kind) {
		case 'string':
			return 'string';
		case 'url':
			return 'url';
		case 'date':
			return 'date';
		case 'instant':
			return 'UTC instant';
		case 'datetime':
			return 'date-time string';
		case 'integer':
			return 'integer';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'select':
			return `one of ${valuesText(expected.values)}`;
		case 'tags':
			return 'array of strings';
		case 'multiSelect':
			return `array containing one of ${valuesText(expected.values)}`;
		case 'json':
			return 'JSON matching the field schema';
		case 'reference':
			return 'reference';
		default:
			return expected satisfies never;
	}
}
