/**
 * @fileoverview Serialization utilities for converting between CellValue and SerializedCellValue
 *
 * Handles conversion from CRDT types (Y.Text, Y.Array) to plain JavaScript values
 * and validation of serialized values.
 */

import * as Y from 'yjs';
import type { CellValue, ColumnSchema, SerializedCellValue } from './types';

/**
 * Serializes a single cell value to its plain JavaScript equivalent.
 * - Y.Text → string
 * - Y.Array<T> → T[]
 * - DateWithTimezoneString → returned as-is (already in string format)
 * - Other types → unchanged (primitives, null, undefined)
 *
 * @example
 * ```typescript
 * const ytext = new Y.Text();
 * ytext.insert(0, 'Hello');
 * serializeCellValue(ytext); // 'Hello'
 *
 * const yarray = Y.Array.from(['a', 'b', 'c']);
 * serializeCellValue(yarray); // ['a', 'b', 'c']
 *
 * const date = '2024-01-01T00:00:00.000Z|America/New_York'; // stored as string in YJS
 * serializeCellValue(date); // '2024-01-01T00:00:00.000Z|America/New_York'
 *
 * serializeCellValue(null); // null
 * serializeCellValue(42); // 42
 * serializeCellValue('text'); // 'text'
 * ```
 */
export function serializeCellValue<T extends ColumnSchema>(
	value: CellValue<T>,
): SerializedCellValue<T> {
	if (value instanceof Y.Text) {
		return value.toString() as SerializedCellValue<T>;
	}
	if (value instanceof Y.Array) {
		return value.toArray() as SerializedCellValue<T>;
	}
	// Date values are already stored as DateWithTimezoneString in YJS, so return as-is
	return value as SerializedCellValue<T>;
}
