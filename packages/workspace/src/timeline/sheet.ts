import * as Y from 'yjs';
import { generateId } from '../shared/id.js';
import { generateInitialOrders } from '../shared/fractional-index.js';

/**
 * Escape a CSV field value per RFC 4180.
 * Fields containing commas, quotes, or newlines are wrapped in quotes.
 * Internal quotes are escaped as "".
 */
function escapeCsvField(value: string): string {
	if (value.includes(',') || value.includes('"') || value.includes('\n')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * Parse CSV string into 2D array per RFC 4180.
 * Handles quoted fields, escaped quotes, and newlines within fields.
 */
function parseCsvRows(csv: string): string[][] {
	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentField = '';
	let inQuotes = false;
	let i = 0;

	while (i < csv.length) {
		const char = csv[i];
		const nextChar = csv[i + 1];

		if (inQuotes) {
			if (char === '"' && nextChar === '"') {
				// Escaped quote within quoted field
				currentField += '"';
				i += 2;
			} else if (char === '"') {
				// End of quoted field
				inQuotes = false;
				i++;
			} else {
				// Regular character within quoted field
				currentField += char;
				i++;
			}
		} else {
			if (char === '"') {
				// Start of quoted field
				inQuotes = true;
				i++;
			} else if (char === ',') {
				// Field delimiter
				currentRow.push(currentField);
				currentField = '';
				i++;
			} else if (char === '\n') {
				// Row delimiter
				currentRow.push(currentField);
				if (currentRow.length > 0) {
					rows.push(currentRow);
				}
				currentRow = [];
				currentField = '';
				i++;
			} else if (char === '\r' && nextChar === '\n') {
				// CRLF row delimiter
				currentRow.push(currentField);
				if (currentRow.length > 0) {
					rows.push(currentRow);
				}
				currentRow = [];
				currentField = '';
				i += 2;
			} else {
				// Regular character
				currentField += char;
				i++;
			}
		}
	}

	// Handle final field and row
	if (currentField || currentRow.length > 0) {
		currentRow.push(currentField);
		if (currentRow.length > 0) {
			rows.push(currentRow);
		}
	}

	return rows;
}

/**
 * Serialize a sheet's columns and rows Y.Maps to a CSV string.
 *
 * 1. Sort columns by fractional `order`
 * 2. Write header row (column names)
 * 3. Sort rows by fractional `order`
 * 4. For each row, read cell values by column ID (empty string for missing)
 * 5. Escape values containing commas, quotes, or newlines (RFC 4180)
 */
export function serializeSheetToCsv(
	columns: Y.Map<Y.Map<string>>,
	rows: Y.Map<Y.Map<string>>,
): string {
	// Collect and sort columns by order
	const columnEntries: Array<{
		id: string;
		colMap: Y.Map<string>;
		order: number;
	}> = [];
	columns.forEach((colMap, colId) => {
		const orderStr = colMap.get('order') ?? '0';
		columnEntries.push({
			id: colId,
			colMap,
			order: Number.parseFloat(orderStr),
		});
	});
	columnEntries.sort((a, b) => a.order - b.order);

	// If no columns, return empty string
	if (columnEntries.length === 0) {
		return '';
	}

	// Write header row
	const headerRow = columnEntries
		.map((col) => escapeCsvField(col.colMap.get('name') ?? ''))
		.join(',');
	const lines: string[] = [headerRow];

	// Collect and sort rows by order
	const rowEntries: Array<{
		id: string;
		rowMap: Y.Map<string>;
		order: number;
	}> = [];
	rows.forEach((rowMap, rowId) => {
		const orderStr = rowMap.get('order') ?? '0';
		rowEntries.push({
			id: rowId,
			rowMap,
			order: Number.parseFloat(orderStr),
		});
	});
	rowEntries.sort((a, b) => a.order - b.order);

	// Write data rows
	for (const row of rowEntries) {
		const cellValues = columnEntries.map((col) => {
			const cellValue = row.rowMap.get(col.id) ?? '';
			return escapeCsvField(cellValue);
		});
		lines.push(cellValues.join(','));
	}

	return `${lines.join('\n')}\n`;
}

/**
 * Parse a CSV string and populate columns and rows Y.Maps.
 *
 * 1. Parse CSV (handle quoted fields per RFC 4180)
 * 2. First row = column headers → create column Y.Maps with generated IDs
 * 3. Subsequent rows → create row Y.Maps with generated IDs
 * 4. Assign fractional order strings to columns and rows (sequential)
 */
export function parseSheetFromCsv(
	csv: string,
	columns: Y.Map<Y.Map<string>>,
	rows: Y.Map<Y.Map<string>>,
): void {
	// Handle empty input
	if (!csv || csv.trim() === '') {
		return;
	}

	const parsed = parseCsvRows(csv);
	if (parsed.length === 0) {
		return;
	}

	// First row is headers
	const headers = parsed[0];
	if (!headers || headers.length === 0) {
		return;
	}

	// Generate column IDs and orders
	const columnIds = headers.map(() => generateId());
	const columnOrders = generateInitialOrders(headers.length);

	// Create column Y.Maps
	for (let i = 0; i < headers.length; i++) {
		const colMap = new Y.Map<string>();
		colMap.set('name', headers[i] ?? '');
		colMap.set('kind', 'text');
		colMap.set('width', '120');
		colMap.set('order', String(columnOrders[i]));
		const columnId = columnIds[i];
		if (!columnId) continue;
		columns.set(columnId, colMap);
	}

	// Remaining rows are data
	const dataRows = parsed.slice(1);
	if (dataRows.length === 0) {
		return;
	}

	const rowOrders = generateInitialOrders(dataRows.length);

	// Create row Y.Maps
	for (let i = 0; i < dataRows.length; i++) {
		const rowMap = new Y.Map<string>();
		rowMap.set('order', String(rowOrders[i]));

		// Set cell values for each column
		const dataRow = dataRows[i];
		if (dataRow) {
			for (let j = 0; j < columnIds.length; j++) {
				const cellValue = dataRow[j] ?? '';
				if (cellValue) {
					const columnId = columnIds[j];
					if (!columnId) continue;
					rowMap.set(columnId, cellValue);
				}
			}
		}

		rows.set(generateId(), rowMap);
	}
}
