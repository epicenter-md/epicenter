import {
	compile,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	storageOf,
} from '@epicenter/field';
import {
	type Static,
	type TNull,
	type TObject,
	type TSchema,
	type TUnion,
	Type,
} from 'typebox';
import { assertSafeSegment } from '../shared/safe-segment.js';

export type Columns = Record<string, TSchema>;
export type DocLayout = 'plainText' | 'richText';

export type TableOptions<TColumns extends Columns> = {
	indexes?: readonly (readonly (keyof TColumns & string)[])[];
	docs?: Readonly<Record<string, DocLayout>>;
};

export type CompiledColumn = {
	name: string;
	kind: Kind;
	storage: ReturnType<typeof storageOf>;
	isNullable: boolean;
	referenceTable: string | null;
	check(value: unknown): boolean;
};

export type TableDefinition<
	TColumns extends Columns = Columns,
	TDocs extends Readonly<Record<string, DocLayout>> = Readonly<
		Record<string, DocLayout>
	>,
> = {
	columns: TColumns;
	schema: TObject<TColumns>;
	options: {
		indexes: readonly (readonly (keyof TColumns & string)[])[];
		docs: TDocs;
	};
	compiledColumns: { [TName in keyof TColumns]: CompiledColumn };
};

export type RowFor<TDefinition extends { schema: TSchema }> = Static<
	TDefinition['schema']
> & { id: string };

type TableColumns = Columns & { id: TSchema };

type NullableFieldError =
	'Fields that admit null must be explicitly wrapped in nullable(...)​';

type ConstrainNullAxis<TSchemaValue extends TSchema> =
	null extends Static<TSchemaValue>
		? TSchemaValue extends TUnion<[TSchema, TNull]>
			? TSchemaValue
			: NullableFieldError
		: TSchemaValue;

type ConstrainTableColumns<TColumns extends TableColumns> = {
	[TName in keyof TColumns]: ConstrainNullAxis<TColumns[TName]>;
};

export function defineTable<
	const TColumns extends TableColumns,
	const TOptions extends TableOptions<TColumns> = Record<never, never>,
>(
	columns: ConstrainTableColumns<TColumns>,
	options?: TOptions,
): TableDefinition<
	TColumns,
	TOptions extends { docs: infer TDocs extends Record<string, DocLayout> }
		? TDocs
		: Readonly<Record<never, never>>
> {
	const authoredColumns = columns as TColumns;
	assertSchemaRecord(authoredColumns, 'table columns', 'table column');
	const compiledColumns = Object.fromEntries(
		Object.entries(authoredColumns).map(([name, schema]) => [
			name,
			compileColumn(name, schema),
		]),
	) as { [TName in keyof TColumns]: CompiledColumn };

	const id = compiledColumns.id;
	if (id.kind !== 'string' || id.isNullable) {
		throw new Error(
			"Table column 'id' must be a non-null field.string() schema",
		);
	}

	const indexes = options?.indexes ?? [];
	for (const [indexPosition, index] of indexes.entries()) {
		if (index.length === 0) {
			throw new Error(`Table index ${indexPosition + 1} must name a column`);
		}
		const names = new Set<string>();
		for (const name of index) {
			if (!Object.hasOwn(authoredColumns, name)) {
				throw new Error(`Table index references unknown column '${name}'`);
			}
			if (names.has(name)) {
				throw new Error(`Table index repeats column '${name}'`);
			}
			names.add(name);
		}
	}

	const docs = options?.docs ?? {};
	assertSchemaRecord(docs, 'table documents', 'table document');
	for (const [name, layout] of Object.entries(docs)) {
		assertSafeSegment(name, 'child document name');
		if (Object.hasOwn(authoredColumns, name)) {
			throw new Error(`Table document '${name}' collides with a column`);
		}
		if (layout !== 'plainText' && layout !== 'richText') {
			throw new Error(
				`Table document '${name}' has unknown layout '${layout}'`,
			);
		}
	}

	return {
		columns: authoredColumns,
		schema: Type.Object(authoredColumns, { additionalProperties: false }),
		options: { indexes, docs } as TableDefinition<
			TColumns,
			TOptions extends {
				docs: infer TDocs extends Record<string, DocLayout>;
			}
				? TDocs
				: Readonly<Record<never, never>>
		>['options'],
		compiledColumns,
	};
}

type KvSchemaError =
	'KV schemas cannot admit null because null is reserved for clear​';

export type KvDefinition<TSchemaValue extends TSchema = TSchema> = {
	schema: TSchemaValue;
	defaultValue: () => Static<TSchemaValue>;
	compiledValue: CompiledColumn;
};

export function defineKv<
	const TSchemaValue extends TSchema,
	const TDefault extends Static<TSchemaValue>,
>(
	schema: null extends Static<TSchemaValue> ? KvSchemaError : TSchemaValue,
	defaultValue: () => TDefault,
): KvDefinition<TSchemaValue> {
	const compiledValue = compileColumn('value', schema as TSchema);
	if (compiledValue.check(null)) {
		throw new Error(
			'KV schemas cannot admit null because null is reserved for clear',
		);
	}

	let initialDefault: unknown;
	try {
		initialDefault = defaultValue();
	} catch (cause) {
		throw new Error('KV default factory threw during definition', { cause });
	}
	if (!compiledValue.check(initialDefault)) {
		throw new Error('KV default does not satisfy its field schema');
	}

	return {
		schema: schema as TSchemaValue,
		defaultValue,
		compiledValue,
	};
}

export type MigrationTx = {
	sql(query: string, ...params: unknown[]): unknown[];
};

export type RowRef = { table: string; rowId: string };

export type LogicalRow = RowRef & {
	cells: Record<string, unknown>;
};

export type EpochMigration = {
	id: string;
	mapIdentity?(source: RowRef): RowRef | null;
	transformCells?(row: LogicalRow, target: RowRef): Record<string, unknown>;
};

export type MigrationStep = {
	apply?(tx: MigrationTx): void;
	epoch?: EpochMigration;
};

export type TableDefinitions = Record<string, TableDefinition>;
export type KvDefinitions = Record<string, KvDefinition>;

export type WorkspaceDefinition<
	TTables extends TableDefinitions = TableDefinitions,
	TKv extends KvDefinitions = KvDefinitions,
> = {
	id: string;
	name: string;
	epoch: string;
	tables: TTables;
	kv: TKv;
	migrations: readonly MigrationStep[];
	storageRevision: number;
	/** Canonical JSON material for exact logical-schema compatibility. */
	schemaIdentity: string;
};

export function defineWorkspace<
	const TTables extends TableDefinitions,
	const TKv extends KvDefinitions = Record<never, never>,
>({
	id,
	name,
	epoch,
	tables,
	kv,
	migrations = [],
}: {
	id: string;
	name: string;
	epoch: string;
	tables: TTables;
	kv?: TKv;
	migrations?: readonly MigrationStep[];
}): WorkspaceDefinition<TTables, TKv> {
	if (id.trim() === '') throw new Error('Workspace id must not be empty');
	if (name.trim() === '') throw new Error('Workspace name must not be empty');
	if (epoch.trim() === '') throw new Error('Workspace epoch must not be empty');
	assertSchemaRecord(tables, 'workspace tables', 'workspace table');

	const epochIds = new Set([epoch]);
	for (const [position, migration] of migrations.entries()) {
		if (migration.apply === undefined && migration.epoch === undefined) {
			throw new Error(`Workspace migration ${position + 1} does no work`);
		}
		const migrationEpoch = migration.epoch?.id;
		if (migrationEpoch === undefined) continue;
		if (migrationEpoch.trim() === '') {
			throw new Error(
				`Workspace migration ${position + 1} has an empty epoch id`,
			);
		}
		if (epochIds.has(migrationEpoch)) {
			throw new Error(`Workspace epoch id '${migrationEpoch}' is duplicated`);
		}
		epochIds.add(migrationEpoch);
	}

	for (const [tableName, table] of Object.entries(tables)) {
		if (Object.keys(table.options.docs).length > 0) {
			assertSafeSegment(id, 'workspace id');
			assertSafeSegment(tableName, 'child document table name');
		}
		for (const column of Object.values(table.compiledColumns)) {
			if (
				column.referenceTable !== null &&
				!Object.hasOwn(tables, column.referenceTable)
			) {
				throw new Error(
					`Table '${tableName}' column '${column.name}' references unknown table '${column.referenceTable}'`,
				);
			}
		}
	}

	const declaredKv = (kv ?? {}) as TKv;
	assertSchemaRecord(declaredKv, 'workspace KV', 'workspace KV key');
	return {
		id,
		name,
		epoch,
		tables,
		kv: declaredKv,
		migrations,
		storageRevision: 1 + migrations.length,
		schemaIdentity: createSchemaIdentity({
			workspaceId: id,
			tables,
			kv: declaredKv,
			epochIds: [
				epoch,
				...migrations.flatMap((migration) =>
					migration.epoch === undefined ? [] : [migration.epoch.id],
				),
			],
		}),
	};
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
			if (!isJsonValue(value)) return false;
			if (value === null && nullableInner !== null) return true;
			return checkInner(value);
		},
	};
}

function createSchemaIdentity({
	workspaceId,
	tables,
	kv,
	epochIds,
}: {
	workspaceId: string;
	tables: TableDefinitions;
	kv: KvDefinitions;
	epochIds: readonly string[];
}): string {
	return canonicalJson({
		workspaceId,
		tables: Object.entries(tables)
			.sort(([left], [right]) => compareCodeUnits(left, right))
			.map(([tableName, table]) => {
				return {
					name: tableName,
					columns: Object.entries(table.columns)
						.sort(([left], [right]) => compareCodeUnits(left, right))
						.map(([columnName, schema]) => ({
							name: columnName,
							schema: toAtRestSchema(schema),
						})),
					docs: Object.entries(table.options.docs)
						.sort(([left], [right]) => compareCodeUnits(left, right))
						.map(([docName, layout]) => ({
							name: docName,
							layout,
						})),
				};
			}),
		kv: Object.entries(kv)
			.sort(([left], [right]) => compareCodeUnits(left, right))
			.map(([key, definition]) => ({
				key,
				schema: toAtRestSchema(definition.schema),
			})),
		epochIds,
	});
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) {
			throw new Error('Schema identity material must be JSON serializable');
		}
		return encoded;
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
		)
		.join(',')}}`;
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
