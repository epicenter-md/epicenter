/**
 * attach-timeline: Multi-mode document primitive.
 *
 * `attachTimeline` reserves `ydoc.getArray('timeline')` as an append-only
 * log of typed entries (text, richtext, sheet) and exposes mode-switching
 * accessors (`asText`, `asRichText`, `asSheet`). Unlike the fixed-slot
 * primitives (`attachPlainText`, `attachRichText`), timeline stores all
 * content types inside Y.Array entries: each mode switch appends a new
 * entry rather than mutating a shared slot in place.
 *
 * Sub-modules:
 * - `timeline.ts`: core `attachTimeline` + entry types + observe
 * - `sheet.ts`: `SheetBinding` type + CSV serialization helpers
 * - `richtext.ts`: `populateFragmentFromText` authoring helper
 * - `fractional-index.ts`: ordering keys for sheet columns/rows
 *
 * @module
 */

export {
	computeMidpoint,
	generateInitialOrders,
} from './fractional-index.js';
export { populateFragmentFromText } from './richtext.js';
export {
	parseSheetFromCsv,
	type SheetBinding,
	serializeSheetToCsv,
} from './sheet.js';
export {
	attachTimeline,
	type ContentType,
	type RichTextEntry,
	type SheetEntry,
	type TextEntry,
	type Timeline,
	type TimelineEntry,
} from './timeline.js';
