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
	type DataField,
	defineData,
	defineKv,
	defineTable,
	type FieldMap,
	field,
	KV_ROOT,
	type KvOf,
	type NewRowOf,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
	RESERVED_ATTRIBUTE_PREFIX,
	type RowFile,
	type RowFileCodec,
	type RowFileCodecOf,
	RowFileError,
	type RowOf,
	type RowValues,
	type ScalarsOf,
	type TypesOf,
	YJS_TYPE_KEYWORD,
} from './definition.js';
export * from './json.js';
