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
	type DataDefinition,
	DataDefinitionParseError,
	defineData,
	defineKv,
	defineTable,
	type FieldMap,
	field,
	type KvOf,
	type NewRowOf,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
	RESERVED_ATTRIBUTE_PREFIX,
	type RowFileCodecOf,
	RowFileError,
	type RowOf,
	type RowValues,
	type ScalarsOf,
	type TableDeclaration,
} from './definition.js';
export * from './json.js';
