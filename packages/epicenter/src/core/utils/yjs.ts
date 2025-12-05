import { diffChars } from 'diff';
import * as Y from 'yjs';
import type { PartialSerializedRow, TableSchema } from '../../core/schema';
import { isDateWithTimezoneString } from '../../core/schema';
import type { YRow } from '../db/table-helper';

/**
 * Updates a Y.Text object to match a target string by computing and applying the minimal diff.
 *
 * Instead of replacing the entire Y.Text content, this function:
 * 1. Computes the character-level differences between the current state and target string
 * 2. Applies only the necessary insertions and deletions to transform the Y.Text
 * 3. Preserves CRDT character identity where possible for better collaborative editing
 *
 * @param yText - The Y.Text object to update
 * @param newString - The target string that Y.Text should become
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc();
 * const ytext = ydoc.getText('content');
 *
 *
 * // Initial state
 * ytext.insert(0, "Hello World");
 *
 * // Update to new string
 * updateYTextFromString(ytext, "Hello Beautiful World");
 *
 * console.log(ytext.toString()); // "Hello Beautiful World"
 * ```
 */
export function updateYTextFromString(yText: Y.Text, newString: string): void {
	const currentString = yText.toString();

	// Early return if strings are identical
	if (currentString === newString) {
		return;
	}

	const diffs = diffChars(currentString, newString);

	let index = 0;

	// Apply diff operations sequentially
	for (const change of diffs) {
		if (change.added) {
			// Insert new characters at current position
			yText.insert(index, change.value);
			// Advance index by inserted length
			index += change.value.length;
		} else if (change.removed) {
			// Delete characters at current position
			yText.delete(index, change.value.length);
			// Don't advance index - deleted content shifts remaining text left
		} else {
			// Characters match (unchanged), just advance position
			index += change.value.length;
		}
	}
}

/**
 * Updates a Y.Array object to match a target array by computing and applying the minimal diff.
 *
 * Instead of replacing the entire Y.Array content, this function:
 * 1. Computes the element-level differences between the current state and target array
 * 2. Applies only the necessary insertions and deletions to transform the Y.Array
 * 3. Preserves CRDT element identity where possible for better collaborative editing
 *
 * This function uses a simple diff algorithm that compares arrays element by element.
 * For more complex scenarios (e.g., reordering), it may not produce the absolute minimal diff,
 * but it will always converge to the correct final state.
 *
 * @param yArray - The Y.Array object to update
 * @param newArray - The target array that Y.Array should become
 *
 * @example
 * ```typescript
 * const ydoc = new Y.Doc();
 * const yarray = ydoc.getArray('tags');
 *
 * // Initial state
 * yarray.push(['typescript', 'javascript']);
 *
 * // Update to new array
 * updateYArrayFromArray(yarray, ['typescript', 'svelte', 'javascript']);
 *
 * console.log(yarray.toArray()); // ['typescript', 'svelte', 'javascript']
 * ```
 */
export function updateYArrayFromArray<T>(
	yArray: Y.Array<T>,
	newArray: T[],
): void {
	const currentArray = yArray.toArray();

	// Early return if arrays are identical
	if (
		currentArray.length === newArray.length &&
		currentArray.every((item, index) => item === newArray[index])
	) {
		return;
	}

	// Simple diff algorithm: compare element by element
	// This is not the most efficient for complex reorderings, but it's simple and correct

	let currentIndex = 0;
	let newIndex = 0;

	while (currentIndex < currentArray.length || newIndex < newArray.length) {
		const currentItem = currentArray[currentIndex];
		const newItem = newArray[newIndex];

		if (currentItem === newItem) {
			// Items match, move to next
			currentIndex++;
			newIndex++;
		} else if (newIndex >= newArray.length) {
			// We've consumed all new items, delete the rest of current
			yArray.delete(currentIndex, currentArray.length - currentIndex);
			break;
		} else if (currentIndex >= currentArray.length) {
			// We've consumed all current items, insert the rest of new
			const remainingNew = newArray.slice(newIndex);
			yArray.insert(currentIndex, remainingNew);
			break;
		} else {
			// Items don't match
			// Check if current item exists later in new array
			const currentItemIndexInNew = newArray.indexOf(
				currentItem as T,
				newIndex,
			);

			if (currentItemIndexInNew === -1) {
				// Current item not in new array, delete it
				yArray.delete(currentIndex, 1);
				currentArray.splice(currentIndex, 1);
			} else {
				// Current item exists later in new array
				// Insert missing items before it
				const itemsToInsert = newArray.slice(newIndex, currentItemIndexInNew);
				if (itemsToInsert.length > 0) {
					yArray.insert(currentIndex, itemsToInsert);
					currentArray.splice(currentIndex, 0, ...itemsToInsert);
					currentIndex += itemsToInsert.length;
					newIndex += itemsToInsert.length;
				}
				// Now current matches, move forward
				currentIndex++;
				newIndex++;
			}
		}
	}
}

/**
 * Updates a YRow (Y.Map) to match a serialized row by converting values and applying minimal diffs.
 *
 * This function handles two scenarios:
 * 1. Creating a new YRow: Pass a fresh Y.Map and it will be populated
 * 2. Updating an existing YRow: Pass an existing Y.Map and it will be updated with minimal changes
 *
 * For Y.Text fields: Uses updateYTextFromString() for character-level granular updates
 * For Y.Array fields: Uses updateYArrayFromArray() for element-level granular updates
 * For primitives: Directly overwrites values
 *
 * Extra fields in serializedRow (not in schema) are preserved as-is.
 *
 * @param yrow - The Y.Map to update (can be new or existing)
 * @param serializedRow - Plain JavaScript object with serialized values
 * @param schema - The table schema for type conversion
 *
 * @example
 * ```typescript
 * // Create new YRow
 * const yrow = new Y.Map();
 * updateYRowFromSerializedRow({
 *   yrow,
 *   serializedRow: { id: '123', content: 'Hello', tags: ['a', 'b'] },
 *   schema: mySchema
 * });
 *
 * // Update existing YRow with minimal diffs
 * updateYRowFromSerializedRow({
 *   yrow,
 *   serializedRow: { id: '123', content: 'Hello World', tags: ['a', 'b', 'c'] },
 *   schema: mySchema
 * });
 * // Only 'content' and 'tags' are updated with granular diffs
 * ```
 */
export function updateYRowFromSerializedRow<TSchema extends TableSchema>({
	yrow,
	serializedRow,
	schema,
}: {
	yrow: YRow;
	serializedRow: PartialSerializedRow<TSchema>;
	schema: TSchema;
}): void {
	// Iterate over serializedRow to preserve extra fields not in schema
	for (const [fieldName, value] of Object.entries(serializedRow)) {
		// Skip undefined values
		if (value === undefined) continue;

		// Handle null values
		if (value === null) {
			yrow.set(fieldName, null);
			continue;
		}

		// Check if this field is in the schema to determine how to convert it
		const columnSchema = schema[fieldName];

		// Special handling for schema-specific types
		if (columnSchema?.type === 'ytext' && typeof value === 'string') {
			// Convert string → Y.Text or update existing Y.Text
			let ytext = yrow.get(fieldName);
			if (!(ytext instanceof Y.Text)) {
				ytext = new Y.Text();
				yrow.set(fieldName, ytext);
			}
			updateYTextFromString(ytext, value);
		} else if (
			columnSchema?.type === 'date' &&
			isDateWithTimezoneString(value)
		) {
			// Store DateWithTimezoneString directly (no conversion to object)
			yrow.set(fieldName, value);
		} else if (Array.isArray(value)) {
			// Convert any array → Y.Array or update existing Y.Array
			// This handles tags columns and extra fields with arrays
			let yarray = yrow.get(fieldName);
			if (!(yarray instanceof Y.Array)) {
				yarray = new Y.Array();
				yrow.set(fieldName, yarray);
			}
			updateYArrayFromArray(yarray, value);
		} else {
			// Primitives (id, text, integer, boolean, select) stored as-is
			yrow.set(fieldName, value);
		}
	}
}
