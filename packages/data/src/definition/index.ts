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
	type CreateInputOf,
	type CreateInputsOf,
	clearDataDefinitionCache,
	type DataDefinition,
	type DataDefinitionJson,
	DataDefinitionParseError,
	type DataField,
	type DocumentDeclaration,
	type DocumentReader,
	defineData,
	defineKv,
	defineTable,
	type FieldDescriptor,
	type FieldMap,
	type FileCodec,
	field,
	KV_ROOT,
	type KvOf,
	type ParsedDataDefinition,
	type ParsedTable,
	parseData,
	RESERVED_ATTRIBUTE_PREFIX,
	type RowOf,
	type RowsOf,
	type TableDeclaration,
} from './definition.js';
export * from './json.js';
