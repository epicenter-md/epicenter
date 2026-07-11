/**
 * The composed integrity model: one walk that classifies a whole vault.
 *
 * Conformance answers a single table's question (is each cell present, valid, missing) the
 * instant ONE folder is read. Reference resolution is a strictly LATER refinement that needs
 * sibling tables to have loaded. `assess` is the seam where the later data, once present,
 * refines the earlier classification: it widens each per-cell `Cell` into an `AssessedCell`,
 * replacing a reference cell's transient `OK` with the cross-table verdict (resolved / dangling
 * / missing-target) and passing every other cell through unchanged.
 *
 * The point of the composition is that the walk happens ONCE. `assess` returns a rich
 * `VaultIntegrity` that every surface (the grid, the integrity panel, the CLI, the `--json`
 * output) reads as a pure SELECTOR. A `resolved` reference cell carries its target `Row`, so a
 * chip renders the target's title with no second lookup, and the panel and the grid cannot
 * disagree because they read the same cells.
 *
 * `assess` owns the reference classification directly off ONE index. It builds `rowsByTable`
 * (per table, stem to Row over the readable tables) and reads each reference cell's verdict
 * straight from it: the target table absent is `missing-target`, a matched stem is `resolved`
 * (the row is right there in the map), an unmatched stem is `dangling`. Resolution is a single
 * lookup per cell, with no second stem graph or flat findings list to re-index. Reporting the
 * one `missing-target` per column (rather than per row) is a projection concern that lives in
 * `toViolations`, not here.
 *
 * `conformance.ts` is untouched: it keeps producing the four-state `Cell`, and `assess` owns the
 * `Cell -> AssessedCell` widening. The reference verdict is layered on top of conformance, never
 * folded into it.
 */

import { type Field, referenceTargetOf } from '@epicenter/field';
import type { Cell, Extra } from './conformance';
import type { Contract } from './contract';
import { type Row, stemOf } from './parse';
import type { TableRead } from './table';

/**
 * One classified cell, widened from conformance's four-state {@link Cell} with the cross-table
 * reference verdict. Seven states, one exhaustive switch, so a widget renders from `cell.state`
 * alone and never reaches into the vault or a findings list:
 *
 *   - `ok` is a present, valid NON-reference value: a reference cell that is present and valid is
 *     always one of the three reference states below, never `ok`. (An empty reference value is not
 *     a valid pointer; the field contract rejects it, so it arrives here as `invalid`, not `ok`.)
 *   - `missing-required` / `missing-optional` / `invalid` are SHARED with references: a required
 *     reference can be absent, an optional one too, and an empty or non-string reference value is
 *     `invalid`.
 *   - `resolved` / `dangling` / `missing-target` are the reference-only refinement of a present,
 *     valid pointer. `resolved` carries the target {@link Row} so a chip needs no second lookup.
 */
export type AssessedCell =
	| { field: Field; state: 'ok'; value: unknown }
	| { field: Field; state: 'missing-required' }
	| { field: Field; state: 'missing-optional' }
	| { field: Field; state: 'invalid'; raw: unknown }
	| {
			field: Field;
			state: 'resolved';
			value: string;
			target: string;
			targetRow: Row;
	  }
	| { field: Field; state: 'dangling'; value: string; target: string }
	| { field: Field; state: 'missing-target'; value: string; target: string };

/**
 * The cross-table verdict of a present, valid reference cell: the three reference-only states a
 * widget colors a chip by. `resolved` carries the target {@link Row} so the chip needs no second
 * lookup. The absent / invalid reference states are NOT here; they are the shared conformance
 * states a non-reference cell also has, rendered by the ordinary editor.
 */
export type ReferenceVerdict = Extract<
	AssessedCell,
	{ state: 'resolved' | 'dangling' | 'missing-target' }
>;

/** A row classified against its table's contract: the widened cells plus its untyped extras. */
export type RowAssessment = {
	row: Row;
	cells: AssessedCell[];
	extras: Extra[];
};

/**
 * A table's place in the vault: four honest states, NOT a `loaded | fatal` binary.
 *
 *   - `unreadable` and `invalid-contract` are the two genuine failures, split by cause the way
 *     reference findings split `missing-target` from `dangling`: the folder could not be read at
 *     all, versus a `matter.json` that is present but corrupt. Each carries its message.
 *   - `untyped` is a VALID state, never a failure: a folder with no `matter.json` is a raw,
 *     type-less grid, and it is still a valid reference target (existence is the file existing,
 *     contract or not). It carries its rows and the deterministic column union.
 *   - `typed` is a folder with a usable contract: it carries the contract and its assessed rows.
 *
 * A failed or untyped table contributes no `typed` cells, so it surfaces no reference
 * verdicts of its own. A `typed`, `untyped`, or `invalid-contract` table still parsed its
 * files, so its stems land in the reference index and inbound references resolve against it.
 * Only `unreadable` contributes no stems, because there were no files to read, so it is the one
 * state that turns every inbound reference into `missing-target`.
 */
export type TableAssessment =
	| { name: string; status: 'unreadable'; message: string }
	| { name: string; status: 'invalid-contract'; message: string }
	| { name: string; status: 'untyped'; rows: Row[]; columns: string[] }
	| {
			name: string;
			status: 'typed';
			contract: Contract;
			rows: RowAssessment[];
	  };

/** A Markdown file that could not become a row, located within its table. */
export type LocatedUnreadableFile = {
	table: string;
	fileName: string;
	message: string;
};

/**
 * The one composed structure: every table's assessment, in input order. Deliberately NOT
 * versioned: the prior collapse removed an unread `version` wrapper, and `VaultIntegrity` is an
 * in-memory return, never serialized. The `--json` output serializes the projected violations,
 * not this; a version, if a serialized contract ever needs one, rides on that projection.
 */
export type VaultIntegrity = {
	tables: TableAssessment[];
	unreadableFiles: LocatedUnreadableFile[];
};

/** A table that was read into a {@link TableRead}: the input that contributes rows and stems. */
type ReadableTable = { name: string; status: 'readable'; read: TableRead };

/**
 * A table as it arrives at {@link assess}, tagged by whether the folder could be read. The
 * `readable` case carries its {@link TableRead}; the `unreadable` case is the ONE input that
 * contributes no rows, so inbound references to it resolve to `missing-target`. A `TableRead`
 * already implies the directory listed (its own `unreadable` is per-file), so "could not read
 * the folder" has to arrive as its own variant, tagged on `status` to match {@link TableAssessment}.
 */
export type TableInput =
	| ReadableTable
	| { name: string; status: 'unreadable'; message: string };

/**
 * Classify a whole vault in one walk, composing per-table conformance with cross-table reference
 * resolution. The grid, the integrity panel, and the CLI are all pure selectors over the result.
 *
 * @param tables the vault's tables, each already read (or marked unreadable), in display order.
 */
export function assess(tables: readonly TableInput[]): VaultIntegrity {
	// Per table, stem -> Row, over the readable tables. This is BOTH the existence set (a stem is
	// present iff the file exists) AND the source of a resolved cell's target row, so resolution
	// is a single lookup with no second pass. An unreadable folder had no files to read, so it is
	// excluded and every inbound reference to it falls through to missing-target.
	const rowsByTable = new Map<string, Map<string, Row>>();
	for (const table of tables) {
		if (table.status !== 'readable') continue;
		rowsByTable.set(
			table.name,
			new Map(table.read.rows.map((row) => [stemOf(row.fileName), row])),
		);
	}

	const unreadableFiles = tables.flatMap((table) =>
		table.status === 'readable'
			? table.read.unreadable.map(({ fileName, error }) => ({
					table: table.name,
					fileName,
					message: error.message,
				}))
			: [],
	);

	return {
		tables: tables.map((table) => assessTable(table, rowsByTable)),
		unreadableFiles,
	};
}

/** Classify one table into its four-state assessment. */
function assessTable(
	input: TableInput,
	rowsByTable: Map<string, Map<string, Row>>,
): TableAssessment {
	if (input.status === 'unreadable') {
		return { name: input.name, status: 'unreadable', message: input.message };
	}

	const { name, read } = input;
	const { view } = read;

	if (view.mode === 'untyped') {
		// A junk matter.json is the genuine failure; no matter.json at all is the valid raw grid.
		return view.contractError
			? {
					name,
					status: 'invalid-contract',
					message: view.contractError.message,
				}
			: { name, status: 'untyped', rows: read.rows, columns: view.columns };
	}

	const rows = view.conformance.map((conformance) => ({
		row: conformance.row,
		cells: conformance.cells.map((cell) => assessCell(cell, rowsByTable)),
		extras: conformance.extras,
	}));
	return { name, status: 'typed', contract: view.contract, rows };
}

/**
 * Widen one conformance {@link Cell} into an {@link AssessedCell}. The three non-OK states pass
 * through unchanged. An OK cell is the only one the reference layer can refine: a non-reference
 * OK is `ok`; a reference OK becomes the cross-table verdict read straight from `rowsByTable`.
 */
function assessCell(
	cell: Cell,
	rowsByTable: Map<string, Map<string, Row>>,
): AssessedCell {
	switch (cell.state) {
		case 'MISSING_REQUIRED':
			return { field: cell.field, state: 'missing-required' };
		case 'MISSING_OPTIONAL':
			return { field: cell.field, state: 'missing-optional' };
		case 'INVALID':
			return { field: cell.field, state: 'invalid', raw: cell.raw };
		case 'OK': {
			const target = referenceTargetOf(cell.field);
			// Not a reference, or (defensively) a reference whose OK value is not a string: the
			// reference schema compiles as string, so the latter is unreachable, but conformance
			// carries `value: unknown`. Either way there is no cross-table pointer to resolve.
			if (target === null || typeof cell.value !== 'string') {
				return { field: cell.field, state: 'ok', value: cell.value };
			}

			const value = cell.value;
			// An OK reference value is a non-empty pointer (the field contract rejects "" as
			// invalid), so the verdict reads straight from the one index: target table absent is
			// the whole column unresolvable; a matched stem hands back the target row; an unmatched
			// stem in a present table is a dangling pointer.
			const targetRows = rowsByTable.get(target);
			if (targetRows === undefined) {
				return { field: cell.field, state: 'missing-target', value, target };
			}
			const targetRow = targetRows.get(value);
			return targetRow
				? { field: cell.field, state: 'resolved', value, target, targetRow }
				: { field: cell.field, state: 'dangling', value, target };
		}
	}
}
