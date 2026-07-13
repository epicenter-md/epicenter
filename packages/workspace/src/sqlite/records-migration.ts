import { compile, recognize } from '@epicenter/field';
import type { JsonValue, SnapshotRow } from '@epicenter/record-sync';
import {
	type RecordsSchemaCells,
	type RecordsSchemaRef,
	readCanonicalDescriptorTables,
	recordsSchemaHashOf,
	recordsSchemaRef,
	sealRecordsSchemaIdentity,
} from './schema-descriptor.js';

export type RecordsMigrationSourceEntry =
	| {
			kind: 'row';
			table: string;
			rowId: string;
			cells: Record<string, unknown>;
	  }
	| { kind: 'quarantined'; table: string; rowId: string };

/**
 * One immutable logical source snapshot. Every scan must return the same
 * entries in strict `(table, rowId)` code-unit order. The runner scans twice:
 * once to block the whole migration before application code runs, then once
 * to stream the transformed target with bounded memory.
 *
 * The snapshot owner must enforce immutability across both scans, for example
 * with an authority snapshot at one head or a local read transaction. The
 * runner deliberately does not retain or hash the complete source to re-prove
 * that storage guarantee.
 */
export type RecordsMigrationSourceSnapshot = {
	recordsSchemaHash: string;
	scan(): AsyncIterable<RecordsMigrationSourceEntry>;
};

export type RecordsMigrationSourceBlocker = {
	table: string;
	rowId: string;
	reason: 'nonconforming' | 'quarantined' | 'out-of-order';
};

const MAX_REPORTED_SOURCE_BLOCKERS = 100;

/** The source cannot be migrated without diagnosis or explicit repair. */
export class RecordsMigrationSourceBlockedError extends Error {
	readonly blockers: readonly RecordsMigrationSourceBlocker[];
	readonly blockedRowCount: number;

	constructor(
		blockers: readonly RecordsMigrationSourceBlocker[],
		blockedRowCount: number,
	) {
		const first = blockers[0];
		super(
			first === undefined
				? 'Records migration source is blocked'
				: `Records migration source is blocked at '${first.table}.${first.rowId}' (${first.reason})`,
		);
		this.name = 'RecordsMigrationSourceBlockedError';
		this.blockers = Object.freeze([...blockers]);
		this.blockedRowCount = blockedRowCount;
	}
}

/** A transform emitted cells that do not satisfy its adjacent target schema. */
export class RecordsMigrationTargetValidationError extends Error {
	constructor(table: string, rowId: string, targetRecordsSchemaHash: string) {
		super(
			`Records migration target row '${table}.${rowId}' does not conform to '${targetRecordsSchemaHash}'`,
		);
		this.name = 'RecordsMigrationTargetValidationError';
	}
}

type AnyRecordsSchemaRef = RecordsSchemaRef<
	RecordsSchemaCells,
	'current' | 'historical'
>;

type CellsByTableOf<TRef extends AnyRecordsSchemaRef> =
	TRef extends RecordsSchemaRef<infer TCells, 'current' | 'historical'>
		? TCells
		: never;

type TableKey<TRef extends AnyRecordsSchemaRef> = keyof CellsByTableOf<TRef> &
	string;
type SharedTableKey<
	TFrom extends AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef,
> = Extract<TableKey<TFrom>, TableKey<TTo>>;
type SourceOnlyTableKey<
	TFrom extends AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef,
> = Exclude<TableKey<TFrom>, TableKey<TTo>>;

type IsEqual<TLeft, TRight> = [TLeft] extends [TRight]
	? [TRight] extends [TLeft]
		? true
		: false
	: false;

type ChangedTableKey<
	TFrom extends AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef,
> = {
	[TTable in SharedTableKey<TFrom, TTo>]: IsEqual<
		CellsByTableOf<TFrom>[TTable],
		CellsByTableOf<TTo>[TTable]
	> extends true
		? never
		: TTable;
}[SharedTableKey<TFrom, TTo>];

type RemovedCellError<
	TTable extends string,
	TCell extends string,
> = `Cell "${TCell}" does not exist in target table "${TTable}"; remove it from the transform result​`;

type AuthoredIdError<TTable extends string> =
	`Transform for table "${TTable}" cannot author id; the source row id is preserved​`;

type TransformResult<
	TTable extends string,
	TSourceCells extends Record<string, unknown>,
	TTargetCells extends Record<string, unknown>,
> = TTargetCells & {
	[TCell in Exclude<keyof TSourceCells, keyof TTargetCells> &
		string]?: RemovedCellError<TTable, TCell>;
} & {
	id?: AuthoredIdError<TTable>;
};

type TransformFunction<
	TTable extends string,
	TSourceCells extends Record<string, unknown>,
	TTargetCells extends Record<string, unknown>,
> = (source: {
	id: string;
	cells: TSourceCells;
}) => TransformResult<TTable, TSourceCells, TTargetCells> | null;

type TransformMap<
	TFrom extends AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef,
> = {
	[TTable in SharedTableKey<TFrom, TTo>]?: TransformFunction<
		TTable,
		CellsByTableOf<TFrom>[TTable],
		CellsByTableOf<TTo>[TTable]
	>;
};

type RequiredChangedTransforms<
	TFrom extends AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef,
> = {
	[TTable in ChangedTableKey<TFrom, TTo>]-?: TransformFunction<
		TTable,
		CellsByTableOf<TFrom>[TTable],
		CellsByTableOf<TTo>[TTable]
	>;
};

type DuplicateTupleMember<
	TValues extends readonly string[],
	TSeen extends string = never,
> = TValues extends readonly [
	infer THead extends string,
	...infer TTail extends readonly string[],
]
	? THead extends TSeen
		? THead
		: DuplicateTupleMember<TTail, TSeen | THead>
	: never;

type InvalidDiscardTable<TTable extends string> =
	`Discard table "${TTable}" is not source-only​`;
type MissingDiscardTable<TTable extends string> =
	`Source-only table "${TTable}" must be explicitly discarded​`;
type DuplicateDiscardTable<TTable extends string> =
	`Discard contains duplicate table "${TTable}"​`;

type ValidateDiscardMembers<
	TDiscard extends readonly string[],
	TSourceOnly extends string,
> = {
	[TIndex in keyof TDiscard]: TDiscard[TIndex] extends TSourceOnly
		? TDiscard[TIndex]
		: TDiscard[TIndex] extends string
			? InvalidDiscardTable<TDiscard[TIndex]>
			: TDiscard[TIndex];
};

type ValidateDiscard<
	TDiscard extends readonly string[],
	TSourceOnly extends string,
> = ValidateDiscardMembers<TDiscard, TSourceOnly> &
	(Exclude<TSourceOnly, TDiscard[number]> extends infer TMissing extends string
		? [TMissing] extends [never]
			? unknown
			: readonly MissingDiscardTable<TMissing>[]
		: never) &
	(DuplicateTupleMember<TDiscard> extends infer TDuplicate extends string
		? [TDuplicate] extends [never]
			? unknown
			: readonly DuplicateDiscardTable<TDuplicate>[]
		: never);

type RecordsMigrationOptions<
	TFrom extends AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef,
	TDiscard extends readonly string[],
> = {
	from: TFrom;
	to: TTo;
} & ([ChangedTableKey<TFrom, TTo>] extends [never]
	? { transform?: TransformMap<TFrom, TTo> }
	: {
			transform: TransformMap<TFrom, TTo> &
				RequiredChangedTransforms<TFrom, TTo>;
		}) &
	([SourceOnlyTableKey<TFrom, TTo>] extends [never]
		? {
				discard?: ValidateDiscard<TDiscard, never>;
			}
		: {
				discard: ValidateDiscard<TDiscard, SourceOnlyTableKey<TFrom, TTo>>;
			});

type ParsedEndpoint<TRef extends AnyRecordsSchemaRef = AnyRecordsSchemaRef> = {
	ref: TRef;
	tables: ReadonlyMap<string, string>;
};

type ValidatedStep = {
	from: AnyRecordsSchemaRef;
	to: AnyRecordsSchemaRef;
	transform: Readonly<Record<string, RuntimeTransform>>;
	discard: readonly string[];
};

type RuntimeTransform = (source: {
	id: string;
	cells: Record<string, unknown>;
}) => unknown;

const validatedRecordsMigration = Symbol('validatedRecordsMigration');
const validatedRecordsMigrations = Symbol('validatedRecordsMigrations');

type RecordsMigration<
	TFrom extends AnyRecordsSchemaRef = AnyRecordsSchemaRef,
	TTo extends AnyRecordsSchemaRef = AnyRecordsSchemaRef,
> = {
	readonly from: TFrom;
	readonly to: TTo;
	readonly transform: Readonly<Record<string, (source: never) => unknown>>;
	readonly discard: readonly string[];
	readonly [validatedRecordsMigration]: ValidatedStep;
};

type AnyRecordsMigration = RecordsMigration<
	AnyRecordsSchemaRef,
	AnyRecordsSchemaRef
>;

/**
 * Define one adjacent records-schema step. This validates descriptors and table
 * disposition at module load; it never executes transforms or reads row data.
 */
export function defineRecordsMigration<
	const TFrom extends AnyRecordsSchemaRef,
	const TTo extends AnyRecordsSchemaRef,
	const TDiscard extends readonly string[] = readonly [],
>(
	options: RecordsMigrationOptions<TFrom, TTo, TDiscard>,
): RecordsMigration<TFrom, TTo> {
	const from = validateEndpoint(options.from, 'source');
	const to = validateEndpoint(options.to, 'target');
	if (from.ref.recordsSchemaHash === to.ref.recordsSchemaHash) {
		throw new Error('Records migration must change the records schema hash');
	}
	const transform = options.transform === undefined ? {} : options.transform;
	const discard = options.discard === undefined ? [] : options.discard;
	assertPlainRecord(transform, 'Records migration transform');
	if (
		!Array.isArray(discard) ||
		!discard.every((table) => typeof table === 'string')
	) {
		throw new Error(
			'Records migration discard must be an array of table names',
		);
	}

	const transformEntries = Object.entries(transform);
	for (const [table, callback] of transformEntries) {
		if (typeof callback !== 'function') {
			throw new Error(
				`Records migration transform for table '${table}' must be a function`,
			);
		}
	}

	const discarded = new Set<string>();
	for (const table of discard) {
		if (discarded.has(table)) {
			throw new Error(
				`Records migration discard contains duplicate table '${table}'`,
			);
		}
		discarded.add(table);
		if (Object.hasOwn(transform, table)) {
			throw new Error(
				`Records migration table '${table}' cannot be both transformed and discarded`,
			);
		}
	}

	for (const [table] of transformEntries) {
		const isSource = from.tables.has(table);
		const isTarget = to.tables.has(table);
		if (isSource && isTarget) {
			if (from.tables.get(table) === to.tables.get(table)) {
				throw new Error(
					`Records migration table '${table}' is canonically identical and copies automatically`,
				);
			}
			continue;
		}
		if (isSource) {
			throw new Error(
				`Records migration transform table '${table}' exists only in the source`,
			);
		}
		if (isTarget) {
			throw new Error(
				`Records migration transform table '${table}' exists only in the target`,
			);
		}
		throw new Error(
			`Records migration transform references unknown table '${table}'`,
		);
	}

	for (const table of discarded) {
		if (!from.tables.has(table) || to.tables.has(table)) {
			throw new Error(
				`Records migration discard table '${table}' is not source-only`,
			);
		}
	}

	for (const [table, sourceFingerprint] of from.tables) {
		const targetFingerprint = to.tables.get(table);
		if (targetFingerprint === undefined) {
			if (!discarded.has(table)) {
				throw new Error(
					`Records migration source-only table '${table}' must be explicitly discarded`,
				);
			}
			continue;
		}
		if (
			sourceFingerprint !== targetFingerprint &&
			!Object.hasOwn(transform, table)
		) {
			throw new Error(
				`Records migration table '${table}' changed canonically and requires a transform`,
			);
		}
	}

	const frozenTransform = Object.freeze({ ...transform }) as Readonly<
		Record<string, RuntimeTransform>
	>;
	const frozenDiscard = Object.freeze([...discard]);
	const validated: ValidatedStep = Object.freeze({
		from: from.ref,
		to: to.ref,
		transform: frozenTransform,
		discard: frozenDiscard,
	});
	return Object.freeze({
		from: from.ref,
		to: to.ref,
		transform: frozenTransform,
		discard: frozenDiscard,
		[validatedRecordsMigration]: validated,
	}) as RecordsMigration<TFrom, TTo>;
}

type Last<TValues extends readonly unknown[]> = TValues extends readonly [
	...unknown[],
	infer TLast,
]
	? TLast
	: never;

type TerminalCurrentConstraint<TSteps extends readonly AnyRecordsMigration[]> =
	Last<TSteps> extends RecordsMigration<
		AnyRecordsSchemaRef,
		RecordsSchemaRef<RecordsSchemaCells, 'current'>
	>
		? unknown
		: 'Records migration chain must terminate at a current workspace definition​';

type RecordsMigrations<TSteps extends readonly AnyRecordsMigration[]> =
	Readonly<TSteps> & {
		readonly [validatedRecordsMigrations]: true;
	};

/** Validate one non-empty linear chain ending at the current workspace. */
export function defineRecordsMigrations<
	const TSteps extends readonly [AnyRecordsMigration, ...AnyRecordsMigration[]],
>(
	steps: TSteps & TerminalCurrentConstraint<TSteps>,
): RecordsMigrations<TSteps> {
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error('Records migration chain must contain at least one step');
	}
	const validated = steps.map((step, index) => {
		const metadata =
			typeof step === 'object' && step !== null
				? step[validatedRecordsMigration]
				: undefined;
		if (metadata === undefined) {
			throw new Error(
				`Records migration chain step ${index + 1} was not created by defineRecordsMigration`,
			);
		}
		return metadata;
	});

	const seenHashes = new Set<string>();
	const seenEdges = new Set<string>();
	const first = validated[0];
	if (first === undefined) {
		throw new Error('Records migration chain must contain at least one step');
	}
	seenHashes.add(first.from.recordsSchemaHash);
	for (const [index, step] of validated.entries()) {
		if (step.from[recordsSchemaRef].kind === 'current') {
			throw new Error(
				`Records migration chain step ${index + 1} starts from a current workspace definition`,
			);
		}
		if (
			step.to[recordsSchemaRef].kind === 'current' &&
			index !== validated.length - 1
		) {
			throw new Error(
				`Records migration chain step ${index + 1} targets a current workspace definition before the terminal step`,
			);
		}
		if (step.from.recordsSchemaHash === step.to.recordsSchemaHash) {
			throw new Error(
				`Records migration step ${index + 1} does not change the records schema hash`,
			);
		}
		const edge = JSON.stringify([
			step.from.recordsSchemaHash,
			step.to.recordsSchemaHash,
		]);
		if (seenEdges.has(edge)) {
			throw new Error(
				`Records migration chain contains duplicate step '${step.from.recordsSchemaHash}' -> '${step.to.recordsSchemaHash}'`,
			);
		}
		seenEdges.add(edge);
		if (index > 0) {
			const previous = validated[index - 1];
			if (previous === undefined) {
				throw new Error('Records migration chain continuity is invalid');
			}
			if (previous.to.recordsSchemaHash !== step.from.recordsSchemaHash) {
				throw new Error(
					`Records migration chain is discontinuous between steps ${index} and ${index + 1}: expected source '${previous.to.recordsSchemaHash}', received '${step.from.recordsSchemaHash}'`,
				);
			}
		}
		if (seenHashes.has(step.to.recordsSchemaHash)) {
			throw new Error(
				`Records migration chain repeats schema hash '${step.to.recordsSchemaHash}'`,
			);
		}
		seenHashes.add(step.to.recordsSchemaHash);
	}

	const terminal = validated.at(-1);
	if (terminal?.to[recordsSchemaRef].kind !== 'current') {
		throw new Error(
			'Records migration chain must terminate at a current workspace definition',
		);
	}
	const bundle = [...steps] as unknown[] & {
		[validatedRecordsMigrations]?: true;
	};
	Object.defineProperty(bundle, validatedRecordsMigrations, { value: true });
	return Object.freeze(bundle) as unknown as RecordsMigrations<TSteps>;
}

type CompiledTable = {
	cells: ReadonlyMap<string, CompiledField>;
	id: CompiledField;
};

type CompiledField = {
	name: string;
	isNullable: boolean;
	check(value: unknown): boolean;
};

type CompiledEndpoint = ReadonlyMap<string, CompiledTable>;

/**
 * Select the unique adjacent suffix from the source hash to current, block on
 * every bad source identity before invoking application code, then lazily emit
 * canonically ordered target rows. The stream retains only one row plus at
 * most 100 source diagnostics in memory.
 */
export function runRecordsMigration<
	const TSteps extends readonly [AnyRecordsMigration, ...AnyRecordsMigration[]],
>({
	migrations,
	source,
}: {
	migrations: RecordsMigrations<TSteps>;
	source: RecordsMigrationSourceSnapshot;
}): AsyncIterable<SnapshotRow> {
	const metadata = readValidatedChain(migrations);
	const start = metadata.findIndex(
		(step) => step.from.recordsSchemaHash === source.recordsSchemaHash,
	);
	if (start === -1) {
		if (metadata.at(-1)?.to.recordsSchemaHash === source.recordsSchemaHash) {
			throw new Error(
				'Records migration source is already at the current schema',
			);
		}
		throw new Error(
			`Records migration chain does not contain source schema '${source.recordsSchemaHash}'`,
		);
	}
	const path = metadata.slice(start);
	const endpoints = new Map<string, CompiledEndpoint>();
	for (const step of path) {
		endpoints.set(step.from.recordsSchemaHash, compileEndpoint(step.from));
		endpoints.set(step.to.recordsSchemaHash, compileEndpoint(step.to));
	}
	const sourceEndpoint = endpoints.get(source.recordsSchemaHash);
	if (!sourceEndpoint)
		throw new Error('Records migration source endpoint is missing');
	const compiledSourceEndpoint = sourceEndpoint;

	return migrate();

	async function* migrate(): AsyncGenerator<SnapshotRow> {
		const blockers: RecordsMigrationSourceBlocker[] = [];
		let blockedRowCount = 0;
		let previousIdentity: readonly [string, string] | undefined;
		for await (const entry of source.scan()) {
			const isOrdered = follows(previousIdentity, entry);
			previousIdentity = [entry.table, entry.rowId];
			const reason = !isOrdered
				? 'out-of-order'
				: entry.kind === 'quarantined'
					? 'quarantined'
					: validateRow(compiledSourceEndpoint, entry) === null
						? 'nonconforming'
						: undefined;
			if (reason === undefined) continue;
			blockedRowCount++;
			if (blockers.length < MAX_REPORTED_SOURCE_BLOCKERS) {
				blockers.push({ table: entry.table, rowId: entry.rowId, reason });
			}
		}
		if (blockedRowCount > 0) {
			throw new RecordsMigrationSourceBlockedError(blockers, blockedRowCount);
		}

		previousIdentity = undefined;
		for await (const entry of source.scan()) {
			if (!follows(previousIdentity, entry) || entry.kind === 'quarantined') {
				throw new Error(
					`Records migration source snapshot changed at '${entry.table}.${entry.rowId}' between scans`,
				);
			}
			previousIdentity = [entry.table, entry.rowId];
			const normalized = validateRow(compiledSourceEndpoint, entry);
			if (normalized === null) {
				throw new Error(
					`Records migration source snapshot changed at '${entry.table}.${entry.rowId}' between scans`,
				);
			}

			let row: SnapshotRow | null = normalized;
			for (const step of path) {
				if (row === null) break;
				const targetEndpoint = endpoints.get(step.to.recordsSchemaHash);
				if (!targetEndpoint) {
					throw new Error('Records migration target endpoint is missing');
				}
				if (!targetEndpoint.has(row.table)) {
					row = null;
					break;
				}
				const transform = step.transform[row.table];
				const transformed =
					transform === undefined
						? row.cells
						: transform({ id: row.rowId, cells: row.cells });
				if (transformed === null) {
					row = null;
					break;
				}
				const candidate = {
					table: row.table,
					rowId: row.rowId,
					cells: transformed,
				};
				const validated = validateRow(targetEndpoint, candidate);
				if (validated === null) {
					throw new RecordsMigrationTargetValidationError(
						row.table,
						row.rowId,
						step.to.recordsSchemaHash,
					);
				}
				row = validated;
			}
			if (row !== null) yield canonicalizeRow(row);
		}
	}
}

function readValidatedChain(
	migrations: readonly AnyRecordsMigration[],
): readonly ValidatedStep[] {
	const branded = migrations as readonly AnyRecordsMigration[] & {
		[validatedRecordsMigrations]?: true;
	};
	if (branded[validatedRecordsMigrations] !== true) {
		throw new Error(
			'Records migration runner requires a chain created by defineRecordsMigrations',
		);
	}
	return migrations.map((step) => step[validatedRecordsMigration]);
}

function compileEndpoint(ref: AnyRecordsSchemaRef): CompiledEndpoint {
	const tables = new Map<string, CompiledTable>();
	for (const table of readCanonicalDescriptorTables(ref.recordsDescriptor)) {
		const fields = table.fields.map(({ name, schema }) =>
			compileDescriptorField(name, schema),
		);
		const id = fields.find((field) => field.name === 'id');
		if (!id || id.isNullable) {
			throw new Error(
				`Records schema '${ref.recordsSchemaHash}' table '${table.name}' has an invalid id field`,
			);
		}
		tables.set(table.name, {
			cells: new Map(
				fields
					.filter((field) => field.name !== 'id')
					.map((field) => [field.name, field]),
			),
			id,
		});
	}
	return tables;
}

function compileDescriptorField(name: string, schema: unknown): CompiledField {
	const nullableInner = readNullableInner(schema);
	const recognized = recognize(nullableInner ?? schema);
	if (recognized === null) {
		throw new Error(`Records schema field '${name}' is not a persisted field`);
	}
	const check = compile(recognized.schema);
	return {
		name,
		isNullable: nullableInner !== null,
		check(value) {
			return (
				isJsonValue(value) &&
				(value === null ? nullableInner !== null : check(value))
			);
		},
	};
}

function validateRow(
	endpoint: CompiledEndpoint,
	row: { table: string; rowId: string; cells: unknown },
): SnapshotRow | null {
	const table = endpoint.get(row.table);
	if (!table?.id.check(row.rowId) || !isPlainRecord(row.cells)) {
		return null;
	}
	if (Object.keys(row.cells).some((name) => !table.cells.has(name))) {
		return null;
	}
	const cells: Record<string, JsonValue> = {};
	for (const field of table.cells.values()) {
		const value = Object.hasOwn(row.cells, field.name)
			? row.cells[field.name]
			: field.isNullable
				? null
				: undefined;
		if (!field.check(value)) return null;
		cells[field.name] = value as JsonValue;
	}
	return { table: row.table, rowId: row.rowId, cells };
}

function canonicalizeRow(row: SnapshotRow): SnapshotRow {
	return {
		table: row.table,
		rowId: row.rowId,
		cells: Object.fromEntries(
			Object.entries(row.cells).filter(([, value]) => value !== null),
		),
	};
}

function follows(
	previous: readonly [string, string] | undefined,
	entry: Pick<RecordsMigrationSourceEntry, 'table' | 'rowId'>,
): boolean {
	if (previous === undefined) return true;
	return (
		compareCodeUnits(previous[0], entry.table) < 0 ||
		(previous[0] === entry.table &&
			compareCodeUnits(previous[1], entry.rowId) < 0)
	);
}

function readNullableInner(schema: unknown): unknown | null {
	if (!isPlainRecord(schema)) return null;
	const anyOf = schema.anyOf;
	if (!Array.isArray(anyOf) || anyOf.length !== 2) return null;
	const nullIndex = anyOf.findIndex(
		(value) =>
			isPlainRecord(value) &&
			Object.keys(value).length === 1 &&
			value.type === 'null',
	);
	return nullIndex === -1 ? null : anyOf[nullIndex === 0 ? 1 : 0];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
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
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: isPlainRecord(value) &&
			Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function validateEndpoint<TRef extends AnyRecordsSchemaRef>(
	ref: TRef,
	label: 'source' | 'target',
): ParsedEndpoint<TRef> {
	if (
		typeof ref?.recordsDescriptor !== 'string' ||
		typeof ref.recordsSchemaHash !== 'string'
	) {
		throw new Error(
			`Records migration ${label} must be a records schema definition`,
		);
	}
	let tables: readonly { name: string; fingerprint: string }[];
	try {
		tables = readCanonicalDescriptorTables(ref.recordsDescriptor);
	} catch (cause) {
		throw new Error(
			`Records migration ${label} descriptor ${errorMessage(cause)}`,
			{ cause },
		);
	}
	const expectedHash = recordsSchemaHashOf(ref.recordsDescriptor);
	if (ref.recordsSchemaHash !== expectedHash) {
		throw new Error(
			`Records migration ${label} hash does not match its descriptor: expected '${expectedHash}', received '${ref.recordsSchemaHash}'`,
		);
	}
	const kind = ref[recordsSchemaRef]?.kind;
	if (kind !== 'current' && kind !== 'historical') {
		throw new Error(
			`Records migration ${label} was not created by defineWorkspace or historicalSchema`,
		);
	}
	return Object.freeze({
		ref: sealRecordsSchemaIdentity(ref),
		tables: new Map(tables.map(({ name, fingerprint }) => [name, fingerprint])),
	});
}

function assertPlainRecord(
	value: unknown,
	label: string,
): asserts value is object {
	if (typeof value !== 'object' || value === null) {
		throw new Error(`${label} must be a plain record`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${label} must be a plain record`);
	}
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message.replace(/^Records schema descriptor /, '')
		: 'is invalid';
}
