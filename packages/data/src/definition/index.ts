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
export {
	type DataDefinition,
	type FieldMap,
	field,
	type KvOf,
	type NewRowOf,
	RESERVED_ATTRIBUTE_PREFIX,
	type RowFileCodecOf,
	RowFileError,
	type RowOf,
	type RowValues,
	type ScalarsOf,
	type TableDeclaration,
} from './declaration.js';
export { defineData, defineTable } from './define.js';
export * from './json.js';
