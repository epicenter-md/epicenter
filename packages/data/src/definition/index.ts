/** Inert data-definition vocabulary. Runtime store entrypoints live beside it. */
export {
	DataDefinitionParseError,
	KV_ROOT,
	RESERVED_ATTRIBUTE_PREFIX,
	defineData,
	defineKv,
	defineTable,
	field,
	parseData,
	clearDataDefinitionCache,
	type Conformance,
	type ConformanceIssue,
	type CreateInputOf,
	type CreateInputsOf,
	type DataDefinition,
	type DataDefinitionJson,
	type DataField,
	type DocumentDeclaration,
	type DocumentReader,
	type FieldDescriptor,
	type FieldMap,
	type FileCodec,
	type KvOf,
	type ParsedDataDefinition,
	type ParsedTable,
	type RowOf,
	type RowsOf,
	type TableDeclaration,
} from './definition.js';
export {
	CalendarDateString,
	DateTimeString,
	InstantString,
	jsonValue,
	referenceTargetOf,
	storageOf,
	type Field,
	type FieldOf,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
} from '@epicenter/field';
export * from './addresses.js';
export * from './canonical.js';
export * from './json.js';
export * from './observation.js';
