/**
 * Human text over the flat projections: {@link Violation}[] grouped by where it happened, plus a
 * {@link Summary} roll-up line. The CLI text edge that mirrors the `--json` edge; both read the
 * same selectors, so the printed report and the serialized one carry the same facts.
 *
 * The "what was expected" phrase for an `invalid-type` violation is the shared `describeExpected`
 * -> `formatExpected` projection in `core/expected` (the same pair the in-app integrity panel
 * reads); the violation carries its field, so the phrase is computed HERE at render time, never
 * stored upstream.
 */

import { describeExpected, formatExpected } from '../core/expected';
import type { Summary, Violation } from '../core/violations';

function plural(count: number, word: string, pluralWord = `${word}s`): string {
	return `${count} ${count === 1 ? word : pluralWord}`;
}

/** A short, quoted preview of a raw value, truncated so one bad blob cannot flood the report. */
function previewValue(value: unknown): string {
	const text =
		typeof value === 'string'
			? JSON.stringify(value)
			: (JSON.stringify(value) ?? String(value));
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The one-line body of a row-scoped violation (table-scoped ones print under their table). */
function violationLine(violation: Violation): string {
	switch (violation.kind) {
		case 'missing-required':
			return `  ${violation.field}  needs value`;
		case 'invalid-type':
			return `  ${violation.field.name}  invalid: got ${previewValue(violation.raw)}, expected ${formatExpected(describeExpected(violation.field))}`;
		case 'dangling-reference':
			return `  ${violation.field}  dangling: "${violation.value}" not found in ${violation.target}`;
		case 'missing-target':
			return `  ${violation.field}  references ${violation.target}: no such table in the vault`;
	}
}

/** The row a violation belongs to for grouping; table-scoped `missing-target` has no row. */
function locationOf(violation: Violation): string {
	if (violation.kind === 'missing-target') return violation.table;
	return `${violation.table}/${violation.row}`;
}

/** Group violations under their location, preserving first-seen order. */
function groupByLocation(
	violations: readonly Violation[],
): Array<[string, Violation[]]> {
	const groups = new Map<string, Violation[]>();
	for (const violation of violations) {
		const key = locationOf(violation);
		const lines = groups.get(key) ?? [];
		lines.push(violation);
		groups.set(key, lines);
	}
	return [...groups.entries()];
}

/**
 * One line per table that could not be loaded. These carry no cells, so they never appear as a
 * violation; named here so a fatal is visible above the roll-up, not just a count in it.
 */
function fatalTableLines(summary: Summary): string[] {
	const lines: string[] = [];
	for (const table of summary.tables) {
		if (table.status === 'unreadable') {
			lines.push(`${table.name}\n  can't read: ${table.message}`);
		} else if (table.status === 'invalid-contract') {
			lines.push(`${table.name}\n  invalid contract: ${table.message}`);
		}
	}
	return lines;
}

/** The closing roll-up line: ready / attention, plus failures and untyped notes. */
function summaryLine(summary: Summary): string {
	const {
		tables,
		rows,
		ready,
		needsAttention,
		unreadableTables,
		unreadableFiles,
		invalidContract,
		untyped,
	} = summary.totals;

	const parts = [`${ready} ready`];
	if (needsAttention > 0) {
		parts.push(
			`${needsAttention} ${needsAttention === 1 ? 'needs' : 'need'} attention`,
		);
	}
	if (unreadableTables > 0)
		parts.push(plural(unreadableTables, 'unreadable table'));
	if (unreadableFiles > 0)
		parts.push(plural(unreadableFiles, 'unreadable file'));
	if (invalidContract > 0) parts.push(`${invalidContract} invalid contract`);
	if (untyped > 0) parts.push(`${untyped} untyped`);

	return `${parts.join(', ')} (${plural(tables, 'table')}, ${plural(rows, 'row')})`;
}

/**
 * The full human report: each location's violations, the extras as notes, and the summary line.
 * Pure over the two selectors, so it is the same answer the panel and `--json` give, in prose.
 */
export function formatReport(
	violations: readonly Violation[],
	summary: Summary,
): string {
	const sections = [
		...fatalTableLines(summary),
		...summary.unreadableFiles.map(
			(file) => `${file.table}/${file.fileName}\n  can't read: ${file.message}`,
		),
		...groupByLocation(violations).map(([location, group]) =>
			[location, ...group.map(violationLine)].join('\n'),
		),
	];

	for (const extra of summary.extras) {
		sections.push(
			`${extra.table}/${extra.row}\n  note: extra keys ${extra.keys.join(', ')}`,
		);
	}

	sections.push(summaryLine(summary));
	return sections.join('\n\n');
}
