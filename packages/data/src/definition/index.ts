/** Inert data-definition vocabulary. Runtime store entrypoints live beside it. */

export {
	CalendarDateString,
	DateTimeString,
	type Field,
	type FieldOf,
	InstantString,
	jsonValue,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	referenceTargetOf,
	storageOf,
} from '@epicenter/field';
export * from './addresses.js';
export * from './canonical.js';
export {
	type Conformance,
	type ConformanceIssue,
	DataDefinitionParseError,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
} from './compile.js';
export { plainText } from './content.js';
export {
	CONTENT_FIELD,
	type ContentCodec,
	ContentError,
	type CreateRowOf,
	type DataDefinition,
	type FieldMap,
	field,
	type KvOf,
	RESERVED_ATTRIBUTE_PREFIX,
	type ReservedRowField,
	type RowOf,
	type ScalarsOf,
	type TableDeclaration,
} from './declaration.js';
export { defineData, defineTable } from './define.js';
export * from './json.js';
