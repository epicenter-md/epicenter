/**
 * Conformance: classify a folder's rows against its contract.
 *
 * Typed fields have row-completeness policy, so the per-cell split is FOUR states:
 *
 *   v == null ? (required ? MISSING_REQUIRED : MISSING_OPTIONAL) : check(v) ? OK : INVALID
 *
 * MISSING_REQUIRED and MISSING_OPTIONAL are the two missing states. Both cover an
 * absent key OR an explicit null; the nullish contract says a bare `title:` in YAML
 * parses to null and must mean the same as an omitted `title`. Missing required cells
 * need attention. Missing optional cells are valid. "Ready to publish" is "every cell
 * is OK or MISSING_OPTIONAL", which is also "the row projects into the typed table".
 *
 * The validator is precompiled on the {@link Field} (built once at contract load in
 * `validateContract`), so classification never recompiles; it reads `field.check`.
 *
 * Extras (frontmatter keys not in the contract's fields) are orthogonal: collected for
 * the per-row expander, never affecting validity. A field whose shape was outside the
 * palette is not a typed field, so its value also surfaces here as an extra.
 */

import type { Field } from '../field/index.js';
import type { ContractField } from './contract';
import type { Row } from './parse';

/**
 * A classified cell is one of four states, each a field applied to a row's value. The
 * state IS the verdict, so value-presence cannot disagree with it, and every member
 * carries its {@link Field} (a consumer reads `cell.field`, never an index into a
 * parallel array). {@link Cell} unions the four; consumers use focused exported
 * subsets like {@link MissingCell} rather than subtracting from the union with
 * `Exclude`.
 */

// The field generic `F` is defaulted to the full {@link Field} union but left
// unconstrained: a per-kind widget pins it to one variant (`FieldOf<'select'>`), and
// TypeScript can't prove a generic `FieldOf<K>` is a subtype of the mapped-union `Field`,
// so an `extends Field` bound here would reject the registry's correlated map. `field: F`
// needs no bound; any non-field `F` is caught where the consumer reads `field.kind`.

/** A conformant cell of field `F`: the value passed its field's schema. */
export type OkCell<F = Field> = {
	field: F;
	state: 'OK';
	value: unknown;
};

/** A missing required cell of field `F`: absent or null, so no value to carry. */
type MissingRequiredCell<F = Field> = {
	field: F;
	state: 'MISSING_REQUIRED';
};

/** A missing optional cell of field `F`: absent or null, and valid by contract policy. */
type MissingOptionalCell<F = Field> = {
	field: F;
	state: 'MISSING_OPTIONAL';
};

/** A missing cell: absent or explicit null, with policy deciding attention. */
export type MissingCell<F = Field> =
	| MissingRequiredCell<F>
	| MissingOptionalCell<F>;

/** A present value out of its field's domain: carries the `raw` value for the repair editor. */
export type InvalidCell<F = Field> = {
	field: F;
	state: 'INVALID';
	raw: unknown;
};

/** One classified cell: exactly one of the four states. */
export type Cell =
	| OkCell
	| MissingRequiredCell
	| MissingOptionalCell
	| InvalidCell;

/** True for cells with no present value, whether required or optional. */
export function isMissing<F>(
	cell: OkCell<F> | MissingCell<F> | InvalidCell<F>,
): cell is MissingCell<F> {
	return cell.state === 'MISSING_REQUIRED' || cell.state === 'MISSING_OPTIONAL';
}

/** A frontmatter key the contract does not declare. Never affects validity. */
export type Extra = {
	key: string;
	value: unknown;
};

/** A row classified against the contract. */
export type RowConformance = {
	row: Row;
	cells: Cell[];
	extras: Extra[];
	/** True iff every cell is OK or MISSING_OPTIONAL (the row projects into the typed table). */
	rowValid: boolean;
};

/**
 * Classify one cell. `value == null` is the nullish branch: an absent key and an
 * explicit `null` both arrive here, with requiredness deciding the verdict.
 */
function classifyCell(field: ContractField, value: unknown): Cell {
	if (value == null) {
		return field.required
			? { field, state: 'MISSING_REQUIRED' }
			: { field, state: 'MISSING_OPTIONAL' };
	}
	if (field.check(value)) return { field, state: 'OK', value };
	return { field, state: 'INVALID', raw: value };
}

/** Classify one row against the precompiled fields. */
export function classifyRow(
	fields: readonly ContractField[],
	row: Row,
): RowConformance {
	const cells = fields.map((field) =>
		classifyCell(field, row.frontmatter[field.name]),
	);

	const typed = new Set(fields.map((f) => f.name));
	const extras: Extra[] = Object.entries(row.frontmatter)
		.filter(([key]) => !typed.has(key))
		.map(([key, value]) => ({ key, value }));

	const rowValid = cells.every(
		(cell) => cell.state === 'OK' || cell.state === 'MISSING_OPTIONAL',
	);

	return { row, cells, extras, rowValid };
}

/**
 * Classify a batch of rows against the precompiled fields. Compilation is the
 * expensive step (`Schema.Compile`), done once in `validateContract`; the fields are
 * threaded in here and never rebuilt per row or per file change.
 */
export function classifyRows(
	fields: readonly ContractField[],
	rows: readonly Row[],
): RowConformance[] {
	return rows.map((row) => classifyRow(fields, row));
}
