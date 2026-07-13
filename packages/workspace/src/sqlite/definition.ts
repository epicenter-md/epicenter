import {
	compile,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	storageOf,
} from '@epicenter/field';
import {
	isAdmissibleCellValue,
	RECORD_SYNC_ADMISSION_LIMITS,
} from '@epicenter/record-sync';
import {
	type Static,
	type TNull,
	type TObject,
	type TSchema,
	type TUnion,
	Type,
} from 'typebox';
import { isKvDefinition } from '../document/define-kv.js';
import type { KvDefinitions } from '../document/kv.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { type DocumentFormat, isDocumentFormat } from './document-format.js';
import {
	createRecordsDescriptor,
	recordsSchemaHashOf,
} from './schema-descriptor.js';

// The preference plane shares one declaration vocabulary across storage
// planes: `defineKv` lives with the document KV implementation, and this
// subpath re-exports it so sqlite-path consumers keep one import site.
// KV schemas may be `nullable(...)`: the preference plane never rides the
// record wire, so null is an ordinary stored value, not a clear signal.
export { defineKv } from '../document/define-kv.js';
export type { KvDefinition, KvDefinitions } from '../document/kv.js';

export type Fields = Record<string, TSchema>;
type TableFields = Fields & { id: TSchema };
type DocumentFormats = Record<string, DocumentFormat>;

export type CompiledColumn = {
	readonly name: string;
	readonly kind: Kind;
	readonly storage: ReturnType<typeof storageOf>;
	readonly isNullable: boolean;
	readonly referenceTable: string | null;
	check(value: unknown): boolean;
};

declare const tableDefinitionBrand: unique symbol;
const tableDefinitions = new WeakSet<object>();

export type TableDefinition<
	TColumns extends TableFields = TableFields,
	TDocuments extends DocumentFormats = DocumentFormats,
> = {
	readonly fields: Readonly<TColumns>;
	readonly schema: TObject<TColumns>;
	readonly documents: Readonly<TDocuments>;
	readonly compiledColumns: Readonly<{
		[TName in keyof TColumns]: CompiledColumn;
	}>;
	readonly [tableDefinitionBrand]: true;
};

export type RowFor<TDefinition extends { schema: TSchema }> = Static<
	TDefinition['schema']
> & { id: string };

type NullableFieldError =
	'Fields that admit null must be explicitly wrapped in nullable(...)​';

type ConstrainNullAxis<TSchemaValue extends TSchema> =
	null extends Static<TSchemaValue>
		? TSchemaValue extends TUnion<[TSchema, TNull]>
			? TSchemaValue
			: NullableFieldError
		: TSchemaValue;

type ConstrainTableColumns<TColumns extends TableFields> = {
	[TName in keyof TColumns]: ConstrainNullAxis<TColumns[TName]>;
};

type TableConfig<
	TColumns extends TableFields = TableFields,
	TDocuments extends DocumentFormats = DocumentFormats,
> = {
	fields: TColumns;
	documents?: TDocuments;
};

export function defineTable<
	const TColumns extends TableFields,
	const TDocuments extends DocumentFormats = Readonly<Record<never, never>>,
>(
	config: Omit<TableConfig<TColumns, TDocuments>, 'fields'> & {
		fields: ConstrainTableColumns<TColumns>;
	},
): TableDefinition<TColumns, Readonly<TDocuments>> {
	const authoredColumns = config.fields as TColumns;
	assertSchemaRecord(authoredColumns, 'table columns', 'table column');
	const ownedColumns = Object.freeze(
		Object.fromEntries(
			Object.entries(authoredColumns).map(([name, schema]) => [
				name,
				snapshotSchema(schema),
			]),
		),
	) as TColumns;
	const compiledColumns = Object.fromEntries(
		Object.entries(ownedColumns).map(([name, schema]) => [
			name,
			Object.freeze(compileColumn(name, schema)),
		]),
	) as { [TName in keyof TColumns]: CompiledColumn };
	Object.freeze(compiledColumns);

	const id = compiledColumns.id;
	if (id.kind !== 'string' || id.isNullable) {
		throw new Error(
			"Table column 'id' must be a non-null field.string() schema",
		);
	}

	// Fail at definition time instead of a cryptic runtime parseMutation
	// refusal: every non-id column becomes one wire cell, so the declared
	// shape must fit the record admission ceilings in every mode.
	const cellColumnCount = Object.keys(ownedColumns).length - 1;
	if (cellColumnCount > RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation) {
		throw new Error(
			`Table declares ${cellColumnCount} cell columns; the record protocol admits at most ${RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation} cells per operation`,
		);
	}
	const encoder = new TextEncoder();
	for (const name of Object.keys(ownedColumns)) {
		if (
			encoder.encode(name).byteLength >
			RECORD_SYNC_ADMISSION_LIMITS.identifierBytes
		) {
			throw new Error(
				`Table column '${name}' exceeds the ${RECORD_SYNC_ADMISSION_LIMITS.identifierBytes}-byte wire identifier ceiling`,
			);
		}
	}

	const authoredDocuments = config.documents ?? ({} as TDocuments);
	assertSchemaRecord(authoredDocuments, 'table documents', 'table document');
	for (const [name, type] of Object.entries(authoredDocuments)) {
		assertSafeSegment(name, 'child document name');
		if (!isDocumentFormat(type)) {
			throw new Error(`Table document '${name}' must use document.*`);
		}
	}
	const ownedDocuments = Object.freeze({ ...authoredDocuments }) as TDocuments;

	const definition = Object.freeze({
		fields: ownedColumns,
		schema: freezeOwnedJson(
			Type.Object(ownedColumns, { additionalProperties: false }),
		),
		documents: ownedDocuments,
		compiledColumns,
	}) as TableDefinition<TColumns, Readonly<TDocuments>>;
	tableDefinitions.add(definition);
	return definition;
}

export type TableDefinitions = Record<string, TableDefinition>;

export type WorkspaceDefinition<
	TTables extends TableDefinitions = TableDefinitions,
	TKv extends KvDefinitions = KvDefinitions,
> = {
	readonly recordsDescriptor: string;
	readonly recordsSchemaHash: string;
	/**
	 * The stable app-defined workspace namespace: it keys local
	 * persistence, sync routing, the KV document, and child-doc guids.
	 */
	readonly id: string;
	/** Display label only (mount labels, sign-in copy). Defaults to `id`. */
	readonly name: string;
	readonly tables: Readonly<TTables>;
	readonly kv: Readonly<TKv>;
	/**
	 * Eager preference-document guid: `<id>.kv` (ADR-0124). Stable across
	 * records epochs; applications do not author epoch values.
	 */
	readonly kvDocumentGuid: string;
};

export function defineWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions = Record<never, never>,
>({
	id,
	name,
	tables,
	kv,
}: {
	id: string;
	name?: string;
	tables: TTables;
	kv?: TKv;
}): WorkspaceDefinition<TTables, TKv> {
	if (id.trim() === '') throw new Error('Workspace id must not be empty');
	assertSafeSegment(id, 'workspace id');
	const displayName = name ?? id;
	if (displayName.trim() === '') {
		throw new Error('Workspace name must not be empty');
	}
	assertSchemaRecord(tables, 'workspace tables', 'workspace table');
	const ownedTables = Object.freeze({ ...tables }) as TTables;

	for (const [tableName, table] of Object.entries(ownedTables)) {
		if (!tableDefinitions.has(table)) {
			throw new Error(`Workspace table '${tableName}' must use defineTable()`);
		}
		if (Object.keys(table.documents).length > 0) {
			assertSafeSegment(tableName, 'child document table name');
		}
		for (const column of Object.values(table.compiledColumns)) {
			if (
				column.referenceTable !== null &&
				!Object.hasOwn(ownedTables, column.referenceTable)
			) {
				throw new Error(
					`Table '${tableName}' column '${column.name}' references unknown table '${column.referenceTable}'`,
				);
			}
		}
	}

	const declaredKv = (kv ?? {}) as TKv;
	assertSchemaRecord(declaredKv, 'workspace KV', 'workspace KV key');
	for (const [key, definition] of Object.entries(declaredKv)) {
		if (!isKvDefinition(definition)) {
			throw new Error(`Workspace KV key '${key}' must use defineKv()`);
		}
	}
	const ownedKv = Object.freeze({ ...declaredKv }) as TKv;

	// KV, documents, and display name are deliberately absent.
	// They have independent identities or are runtime behavior, not accepted
	// SQLite record state.
	const recordsDescriptor = createRecordsDescriptor(
		Object.entries(ownedTables).map(([tableName, table]) => ({
			name: tableName,
			fields: Object.fromEntries(
				Object.entries(table.fields).map(([columnName, schema]) => [
					columnName,
					toAtRestSchema(schema),
				]),
			),
		})),
	);
	const recordsSchemaHash = recordsSchemaHashOf(recordsDescriptor);

	return Object.freeze({
		id,
		name: displayName,
		tables: ownedTables,
		kv: ownedKv,
		kvDocumentGuid: `${id}.kv`,
		recordsDescriptor,
		recordsSchemaHash,
	});
}

function assertSchemaRecord(
	record: object,
	containerLabel: string,
	keyLabel: string,
): void {
	const prototype = Object.getPrototypeOf(record);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${containerLabel} must be a plain record`);
	}
	for (const key of Object.keys(record)) {
		if (Object.hasOwn(Object.prototype, key)) {
			throw new Error(`${keyLabel} '${key}' collides with Object.prototype`);
		}
	}
}

function compileColumn(name: string, authoredSchema: TSchema): CompiledColumn {
	const schema = toAtRestSchema(authoredSchema);
	const nullableInner = readNullableInner(schema);
	const recognized = recognize(nullableInner ?? schema);
	if (recognized === null) {
		throw new Error(
			`Persisted field '${name}' must use field.*${nullableInner === null ? ' or nullable(field.*)' : ''}`,
		);
	}

	const checkInner = compile(recognized.schema);
	if (nullableInner === null && checkInner(null)) {
		throw new Error(
			`Persisted field '${name}' admits null and must be explicitly wrapped in nullable(...)`,
		);
	}
	const isNullable = nullableInner !== null;
	if (
		'maxBytes' in recognized.schema &&
		recognized.schema.maxBytes !== undefined &&
		recognized.schema.maxBytes > RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes
	) {
		throw new Error(
			`Persisted field '${name}' maxBytes exceeds the ${RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes}-byte synchronization ceiling`,
		);
	}
	return {
		name,
		kind: recognized.kind,
		storage: storageOf(recognized.kind),
		isNullable,
		referenceTable:
			recognized.kind === 'reference'
				? recognized.schema[REFERENCE_KEYWORD]
				: null,
		check(value) {
			if (!isJsonValue(value) || !isAdmissibleCellValue(value)) return false;
			if (value === null && nullableInner !== null) return true;
			return checkInner(value);
		},
	};
}

function toAtRestSchema(schema: TSchema): unknown {
	try {
		return JSON.parse(JSON.stringify(schema));
	} catch (cause) {
		throw new Error('Persisted field schema must be JSON serializable', {
			cause,
		});
	}
}

function snapshotSchema<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): TSchemaValue {
	return freezeOwnedJson(toAtRestSchema(schema)) as TSchemaValue;
}

function freezeOwnedJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeOwnedJson(child);
	return Object.freeze(value);
}

function readNullableInner(schema: unknown): unknown | null {
	if (!isRecord(schema)) return null;
	const anyOf = schema.anyOf;
	if (!Array.isArray(anyOf) || anyOf.length !== 2) return null;

	const nullIndex = anyOf.findIndex(isNullSchema);
	if (nullIndex === -1) return null;
	return anyOf[nullIndex === 0 ? 1 : 0];
}

function isNullSchema(value: unknown): boolean {
	return (
		isRecord(value) && Object.keys(value).length === 1 && value.type === 'null'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;

	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const isJson = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return isJson;
}
