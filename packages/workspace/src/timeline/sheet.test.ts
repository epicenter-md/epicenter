/**
 * Sheet CSV Tests
 *
 * Verifies CSV parsing/serialization for sheet-mode timeline entries.
 * These tests keep spreadsheet behavior stable across import and export.
 *
 * Key behaviors:
 * - CSV conversion preserves ordering, escaping, and round-trip fidelity.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet.js';

function createSheetMaps() {
	const ydoc = new Y.Doc();
	const columns = ydoc.getMap('columns') as Y.Map<Y.Map<string>>;
	const rows = ydoc.getMap('rows') as Y.Map<Y.Map<string>>;
	return { ydoc, columns, rows };
}

describe('serializeSheetToCsv', () => {
	test('empty sheet returns empty string', () => {
		const { columns, rows } = createSheetMaps();
		expect(serializeSheetToCsv({ columns, rows })).toBe('');
	});

	test('single column and row serialize to one header and one record', () => {
		const { columns, rows } = createSheetMaps();
		const col = new Y.Map<string>();
		col.set('name', 'Name');
		col.set('order', '0.5');
		columns.set('col1', col);

		const row = new Y.Map<string>();
		row.set('order', '0.5');
		row.set('col1', 'Alice');
		rows.set('row1', row);

		expect(serializeSheetToCsv({ columns, rows })).toBe('Name\nAlice\n');
	});

	test('columns sorted by order property', () => {
		const { columns, rows } = createSheetMaps();
		const colA = new Y.Map<string>();
		colA.set('name', 'A');
		colA.set('order', '0.7');
		columns.set('colA', colA);

		const colB = new Y.Map<string>();
		colB.set('name', 'B');
		colB.set('order', '0.3');
		columns.set('colB', colB);

		const row = new Y.Map<string>();
		row.set('order', '0.5');
		row.set('colA', 'a1');
		row.set('colB', 'b1');
		rows.set('row1', row);

		expect(serializeSheetToCsv({ columns, rows })).toBe('B,A\nb1,a1\n');
	});

	test('missing cell values become empty fields', () => {
		const { columns, rows } = createSheetMaps();
		const colA = new Y.Map<string>();
		colA.set('name', 'A');
		colA.set('order', '0.3');
		columns.set('colA', colA);

		const colB = new Y.Map<string>();
		colB.set('name', 'B');
		colB.set('order', '0.7');
		columns.set('colB', colB);

		const row = new Y.Map<string>();
		row.set('order', '0.5');
		row.set('colA', 'a1');
		// colB is missing
		rows.set('row1', row);

		expect(serializeSheetToCsv({ columns, rows })).toBe('A,B\na1,\n');
	});

	test('escapes commas in cell values', () => {
		const { columns, rows } = createSheetMaps();
		const col = new Y.Map<string>();
		col.set('name', 'Name');
		col.set('order', '0.5');
		columns.set('col1', col);

		const row = new Y.Map<string>();
		row.set('order', '0.5');
		row.set('col1', 'Smith, John');
		rows.set('row1', row);

		expect(serializeSheetToCsv({ columns, rows })).toBe('Name\n"Smith, John"\n');
	});

	test('escapes double quotes in cell values', () => {
		const { columns, rows } = createSheetMaps();
		const col = new Y.Map<string>();
		col.set('name', 'Name');
		col.set('order', '0.5');
		columns.set('col1', col);

		const row = new Y.Map<string>();
		row.set('order', '0.5');
		row.set('col1', 'Say "hello"');
		rows.set('row1', row);

		expect(serializeSheetToCsv({ columns, rows })).toBe('Name\n"Say ""hello"""\n');
	});

	test('escapes newlines in cell values', () => {
		const { columns, rows } = createSheetMaps();
		const col = new Y.Map<string>();
		col.set('name', 'Text');
		col.set('order', '0.5');
		columns.set('col1', col);

		const row = new Y.Map<string>();
		row.set('order', '0.5');
		row.set('col1', 'Line 1\nLine 2');
		rows.set('row1', row);

		expect(serializeSheetToCsv({ columns, rows })).toBe('Text\n"Line 1\nLine 2"\n');
	});

	test('header-only (columns but no rows) returns just header line', () => {
		const { columns, rows } = createSheetMaps();
		const col = new Y.Map<string>();
		col.set('name', 'Name');
		col.set('order', '0.5');
		columns.set('col1', col);

		expect(serializeSheetToCsv({ columns, rows })).toBe('Name\n');
	});
});

describe('parseSheetFromCsv', () => {
	test('basic CSV (3 cols, 2 rows)', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('A,B,C\n1,2,3\n4,5,6\n', { columns, rows });

		expect(columns.size).toBe(3);
		expect(rows.size).toBe(2);

		const colEntries = Array.from(columns.entries());
		expect(colEntries[0]?.[1].get('name')).toBe('A');
		expect(colEntries[1]?.[1].get('name')).toBe('B');
		expect(colEntries[2]?.[1].get('name')).toBe('C');
	});

	test('empty CSV leaves maps empty', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('', { columns, rows });
		expect(columns.size).toBe(0);
		expect(rows.size).toBe(0);
	});

	test('quoted fields with commas', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('Name\n"Smith, John"\n', { columns, rows });

		const rowEntries = Array.from(rows.entries());
		const colEntries = Array.from(columns.entries());
		const colId = colEntries[0]![0];
		expect(rowEntries[0]![1].get(colId)).toBe('Smith, John');
	});

	test('quoted fields with escaped quotes', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('Text\n"Say ""hello"""\n', { columns, rows });

		const rowEntries = Array.from(rows.entries());
		const colEntries = Array.from(columns.entries());
		const colId = colEntries[0]![0];
		expect(rowEntries[0]![1].get(colId)).toBe('Say "hello"');
	});

	test('quoted fields with newlines', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('Text\n"Line 1\nLine 2"\n', { columns, rows });

		const rowEntries = Array.from(rows.entries());
		const colEntries = Array.from(columns.entries());
		const colId = colEntries[0]![0];
		expect(rowEntries[0]![1].get(colId)).toBe('Line 1\nLine 2');
	});

	test('empty cells in CSV', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('A,B,C\n1,,3\n', { columns, rows });

		const rowEntries = Array.from(rows.entries());
		const colEntries = Array.from(columns.entries());
		const row = rowEntries[0]![1];
		const colIdA = colEntries[0]![0];
		const colIdB = colEntries[1]![0];
		const colIdC = colEntries[2]![0];

		expect(row.get(colIdA)).toBe('1');
		expect(row.has(colIdB)).toBe(false); // Empty cell not stored
		expect(row.get(colIdC)).toBe('3');
	});

	test('header-only CSV creates columns, no rows', () => {
		const { columns, rows } = createSheetMaps();
		parseSheetFromCsv('A,B,C\n', { columns, rows });

		expect(columns.size).toBe(3);
		expect(rows.size).toBe(0);
	});
});

describe('round-trip', () => {
	test('CSV → parseSheetFromCsv → serializeSheetToCsv → same CSV', () => {
		const { columns, rows } = createSheetMaps();
		const originalCsv = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA\n';
		parseSheetFromCsv(originalCsv, { columns, rows });
		const serialized = serializeSheetToCsv({ columns, rows });
		expect(serialized).toBe(originalCsv);
	});

	test('CSV with special characters survives round-trip', () => {
		const { columns, rows } = createSheetMaps();
		const originalCsv = 'Text\n"Line 1\nLine 2"\n"Say ""hi"""\n"Smith, John"\n';
		parseSheetFromCsv(originalCsv, { columns, rows });
		const serialized = serializeSheetToCsv({ columns, rows });
		expect(serialized).toBe(originalCsv);
	});
});
