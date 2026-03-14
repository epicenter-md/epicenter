/**
 * Sheet helpers — reorder functions stay here, CSV parse/serialize
 * re-exported from @epicenter/workspace.
 */

import { computeMidpoint } from '@epicenter/workspace';
import type * as Y from 'yjs';

// Re-export CSV helpers from workspace (canonical location)
export {
	computeMidpoint,
	generateInitialOrders,
	parseSheetFromCsv,
	serializeSheetToCsv,
} from '@epicenter/workspace';

/**
 * Reorder a row by updating its fractional order property.
 */
export function reorderRow(
	rows: Y.Map<Y.Map<string>>,
	rowId: string,
	beforeOrder: number,
	afterOrder: number,
): void {
	const rowMap = rows.get(rowId);
	if (!rowMap) return;
	rowMap.set('order', String(computeMidpoint(beforeOrder, afterOrder)));
}

/**
 * Reorder a column by updating its fractional order property.
 */
export function reorderColumn(
	columns: Y.Map<Y.Map<string>>,
	colId: string,
	beforeOrder: number,
	afterOrder: number,
): void {
	const colMap = columns.get(colId);
	if (!colMap) return;
	colMap.set('order', String(computeMidpoint(beforeOrder, afterOrder)));
}
