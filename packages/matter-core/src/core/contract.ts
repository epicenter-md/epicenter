/**
 * The runtime `matter.json` parser/validator.
 *
 * `matter.json` at rest is `{ "fields": { [fieldName]: <a plain JSON Schema> } }`, where
 * each field value is a plain JSON Schema in the closed palette. This module turns that
 * raw JSON into a {@link Contract}: a flat list of {@link ContractField}s, each carrying
 * its kind (the widget / storage classifier) and its precompiled validator, computed
 * ONCE here when the contract loads. "Field" is the source noun (the user defines a
 * folder's fields); SQLite is the one consumer that turns fields into table columns.
 *
 * The palette is the shared `@epicenter/field` vocabulary: the SAME kinds the workspace
 * authors through `field.*`, so `recognize` and `compile` round-trip matter's `matter.json`
 * over one wire-form. `json` is a kind (an arbitrary-JSON payload, marker-discriminated),
 * so matter renders it too. Matter's substrate policy keeps the emptiness axis outside
 * the value schema: `fields.*` is a pure JSON Schema for PRESENT values, while top-level
 * contract policy decides whether a missing value is allowed. A nullable `anyOf`-with-null
 * shape is outside the palette and degrades to raw, and the per-kind widgets in
 * `components/fields/` map each `Kind` to its editor.
 *
 * The acceptance rule is the meta-schema in `@epicenter/field`: a field whose stored
 * shape is a legal palette member becomes a typed Field; a field OUTSIDE the palette (a
 * typo, an unmarked object, a nullable wrapper) is recorded in `untyped` and shown raw,
 * rather than erroring the whole contract. Only WHOLE-FILE junk (bad JSON, a non-object
 * top level) rejects the contract to the raw view; an object with no `fields` map is the
 * canonical untyped marker (the raw grid), not a rejection.
 *
 * Optionality is a Matter policy, not a field-palette kind. By default every typed
 * field is required; top-level `optional: ["name"]` names the exceptions. "Must have
 * content" is still a value constraint (e.g. `minLength`), not a requiredness flag.
 *
 * Searchability is the same shape of policy: top-level `searchable: ["body", "name"]` names the
 * columns indexed for full-text search, defaulting to `body` plus every TEXT-storage field. It lives
 * at the top level (not in a field's value schema) for the same reason `optional` does, and the key
 * exists only because the SQLite projection's FTS5 index exists.
 */

import { compile, type Field, recognize, storageOf } from '@epicenter/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import { parseViews, type ViewError, type ViewSpec } from './view';

/** Why a stored `matter.json` could not be read into a usable contract at all. */
export const ContractError = defineErrors({
	NotAnObject: () => ({ message: 'matter.json must be a JSON object' }),
	InvalidOptional: () => ({
		message: 'matter.json optional must be an array of field names',
	}),
	InvalidSearchable: () => ({
		message: 'matter.json searchable must be an array of column names',
	}),
	InvalidJson: ({ cause }: { cause: unknown }) => ({
		message: `matter.json is not valid JSON: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ContractError = InferErrors<typeof ContractError>;

/** A loaded Matter field: present-value schema plus missing-cell policy. */
export type ContractField = Field & {
	/** True when a missing cell should need attention; false when it is allowed. */
	required: boolean;
};

/** A folder's validated contract: the typed fields plus any fields outside the palette. */
export type Contract = {
	/** The typed fields, in declared (insertion) order. */
	fields: ContractField[];
	/** Field names whose stored shape is outside the palette; shown raw, never typed. */
	untyped: string[];
	/** Optional entries that did not match a typed field, surfaced as contract diagnostics. */
	unmatchedOptional: string[];
	/**
	 * The columns indexed for full-text search (FTS5). Defaults to `body` plus every TEXT-storage
	 * field; a top-level `searchable` array in `matter.json` overrides it (and may drop `body`).
	 * Always filtered to real columns. Empty means no FTS table is projected for the folder.
	 */
	searchable: string[];
	/**
	 * The declared editable views (board only today; ADR-0101), parsed here so they can see field
	 * kinds. Only a typed contract carries views: an untyped marker never reaches this object, so
	 * a `views` key on an untyped table is ignored. The grid never reads this.
	 */
	views: ViewSpec[];
	/** Malformed `views` entries, dropped at load and surfaced as contract diagnostics. */
	viewErrors: ViewError[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed `matter.json` object into a {@link Contract}. Takes the
 * already-JSON-parsed value ({@link parseContract} reads the file text and handles the
 * syntax-error case). Per-field degrade: a field outside the palette is recorded in
 * `untyped`, never an error; only whole-file junk returns an `Err`.
 */
export function validateContract(
	raw: unknown,
): Result<Contract, ContractError> {
	if (!isPlainObject(raw)) return ContractError.NotAnObject();

	// A `matter.json` with no (or an empty) `fields` map is the untyped marker; `parseContract`
	// routes that to the raw grid before it reaches here. Called directly with such an object it
	// degrades to a zero-field contract rather than throwing.
	const fieldsRaw = isPlainObject(raw.fields) ? raw.fields : {};

	const optionalRaw = raw.optional;
	if (
		optionalRaw !== undefined &&
		(!Array.isArray(optionalRaw) ||
			optionalRaw.some((value) => typeof value !== 'string'))
	) {
		return ContractError.InvalidOptional();
	}
	const optional = optionalRaw ?? [];
	const optionalNames = new Set(optional);

	const fields: ContractField[] = [];
	const untyped: string[] = [];
	for (const [name, schema] of Object.entries(fieldsRaw)) {
		// The closed palette is the acceptance rule: `recognize` returns the kind paired
		// with its typed schema, or null for a shape outside it (a typo, an object, a
		// nullable `anyOf` wrapper). An unrecognized field is not a typed field: record it
		// so the UI can nudge, let its value surface as an untyped extra, and keep going.
		const recognized = recognize(schema);
		if (recognized === null) {
			untyped.push(name);
			continue;
		}
		// `recognized` carries the kind and its precisely-typed schema in one pass, so the
		// Field is built with no cast. `compile` runs once per field; its validator rides
		// on the Field for conformance to reuse.
		fields.push({
			name,
			...recognized,
			check: compile(recognized.schema),
			required: !optionalNames.has(name),
		});
	}

	const typed = new Set(fields.map((field) => field.name));
	const unmatchedOptional = optional.filter((name) => !typed.has(name));

	// Searchable is another top-level policy (a sibling of `optional`), resolved to the FTS column
	// list. The default is the body plus every TEXT-storage field; numbers and booleans are not
	// full-text. A `searchable` array overrides it and may drop `body`. Either way, keep only real
	// columns (the body or a typed field) so a stray name can never break the FTS5 `CREATE`.
	const searchableRaw = raw.searchable;
	if (
		searchableRaw !== undefined &&
		(!Array.isArray(searchableRaw) ||
			searchableRaw.some((value) => typeof value !== 'string'))
	) {
		return ContractError.InvalidSearchable();
	}
	const columnNames = new Set(['body', ...fields.map((field) => field.name)]);
	const defaultSearchable = [
		'body',
		...fields
			.filter((field) => storageOf(field.kind) === 'TEXT')
			.map((field) => field.name),
	];
	const searchable = (searchableRaw ?? defaultSearchable).filter((name) =>
		columnNames.has(name),
	);

	// Views are per-entry degrade like the palette: a malformed entry is dropped with a
	// diagnostic, valid entries survive, and the contract itself never errors over them.
	const { views, errors: viewErrors } = parseViews(raw.views, fields);

	return Ok({
		fields,
		untyped,
		unmatchedOptional,
		searchable,
		views,
		viewErrors,
	});
}

/**
 * A `matter.json`'s text, classified into the three things a present marker can be:
 *
 *   - `typed`   the marker declares a non-empty `fields` map: a usable, compiled {@link Contract}.
 *   - `untyped` the marker declares no fields (`{}`, `{"fields":{}}`, or any object without a
 *               non-empty `fields` map): a declared but untyped table, shown as the raw grid.
 *               `{}` is the canonical untyped marker.
 *   - `error`   the marker is broken (bad JSON, or a non-object top level): a claimed table
 *               whose contract could not be read, surfaced as a diagnostic, never silently typed.
 *
 * Absence of `matter.json` is NOT one of these: that is "not a table" and is decided by the loader
 * before any text reaches here (see {@link loadContract}, which adds the no-text case).
 */
export type ParsedContract =
	| { kind: 'untyped' }
	| { kind: 'error'; error: ContractError }
	| { kind: 'typed'; contract: Contract };

/**
 * Parse the raw text of a `matter.json` file into its {@link ParsedContract} classification.
 * Catches JSON syntax errors as `error` rather than throwing, so a junk file degrades to the raw
 * view with a diagnostic; an object with no (or an empty) `fields` map is the untyped marker,
 * never an error.
 */
export function parseContract(text: string): ParsedContract {
	const { data: raw, error } = trySync({
		try: () => JSON.parse(text) as unknown,
		catch: (cause) => ContractError.InvalidJson({ cause }),
	});
	if (error) return { kind: 'error', error };
	if (!isPlainObject(raw)) {
		return { kind: 'error', error: ContractError.NotAnObject().error };
	}
	// No `fields` map, or an empty one (`{}`, `{"fields":{}}`, or any object without declared
	// fields): the untyped marker, a declared table shown as the raw grid. A table is typed only
	// when it declares at least one field, so empty `fields` is untyped, not a strict zero-field
	// table: the `{}`-vs-`{"fields":{}}` distinction (permissive vs strict) was an unguessable flip.
	if (!isPlainObject(raw.fields) || Object.keys(raw.fields).length === 0)
		return { kind: 'untyped' };
	const { data: contract, error: contractError } = validateContract(raw);
	return contractError
		? { kind: 'error', error: contractError }
		: { kind: 'typed', contract };
}
