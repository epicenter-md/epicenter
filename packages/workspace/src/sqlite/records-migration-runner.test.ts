/**
 * Records Migration Runner Tests
 *
 * Verifies the two-pass trusted-client runner over immutable, restartable,
 * canonically ordered logical source snapshots.
 *
 * Key behaviors:
 * - Every source and quarantined row is preflighted before transforms run
 * - Adjacent transforms compose while identical tables copy and ids persist
 * - Omitted rows and source-only tables emit nothing; target-only tables stay empty
 * - Target validation fails with row identity and iteration stays bounded
 */

import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { SnapshotRow } from '@epicenter/record-sync';
import { nullable } from '../document/nullable.js';
import { defineTable, defineWorkspace } from './definition.js';
import { historicalSchema } from './historical-schema.js';
import {
	defineRecordsMigration,
	defineRecordsMigrations,
	RecordsMigrationSourceBlockedError,
	type RecordsMigrationSourceEntry,
	RecordsMigrationTargetValidationError,
	runRecordsMigration,
} from './records-migration.js';

function sourceSnapshot(
	recordsSchemaHash: string,
	entries: readonly RecordsMigrationSourceEntry[],
	onYield?: (scan: number, entry: RecordsMigrationSourceEntry) => void,
) {
	let scans = 0;
	return {
		recordsSchemaHash,
		async *scan() {
			scans++;
			for (const entry of entries) {
				onYield?.(scans, entry);
				yield entry;
			}
		},
		get scans() {
			return scans;
		},
	};
}

async function collect(
	rows: AsyncIterable<SnapshotRow>,
): Promise<SnapshotRow[]> {
	const collected: SnapshotRow[] = [];
	for await (const row of rows) collected.push(row);
	return collected;
}

function defineChain(onTransform?: () => void) {
	const v1Definition = defineWorkspace({
		id: 'notes',
		tables: {
			drafts: defineTable({
				fields: { id: field.string(), body: field.string() },
			}),
			labels: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					summary: nullable(field.string()),
				},
			}),
		},
	});
	const v2Definition = defineWorkspace({
		id: 'notes',
		tables: {
			folders: defineTable({
				fields: { id: field.string(), name: field.string() },
			}),
			labels: v1Definition.tables.labels,
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					summary: nullable(field.string()),
					slug: field.string(),
				},
			}),
		},
	});
	const current = defineWorkspace({
		id: 'notes',
		tables: {
			folders: v2Definition.tables.folders,
			labels: v2Definition.tables.labels,
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					summary: nullable(field.string()),
					slug: field.string(),
					pinned: field.boolean(),
				},
			}),
		},
	});
	const v1 = historicalSchema<{
		drafts: { body: string };
		labels: { name: string };
		notes: { title: string; summary: string | null };
	}>(v1Definition.recordsDescriptor);
	const v2 = historicalSchema<{
		folders: { name: string };
		labels: { name: string };
		notes: {
			title: string;
			summary: string | null;
			slug: string;
		};
	}>(v2Definition.recordsDescriptor);
	const first = defineRecordsMigration({
		from: v1,
		to: v2,
		discard: ['drafts'],
		transform: {
			notes: ({ cells }) => {
				onTransform?.();
				if (cells.title === 'omit') return null;
				return {
					title: cells.title,
					summary: cells.summary,
					slug: cells.title.toLowerCase(),
				};
			},
		},
	});
	const second = defineRecordsMigration({
		from: v2,
		to: current,
		transform: {
			notes: ({ cells }) => ({ ...cells, pinned: false }),
		},
	});
	return {
		current,
		migrations: defineRecordsMigrations([first, second]),
		v1,
		v2,
	};
}

test('multi-step runner copies, transforms, omits, and preserves source ids', async () => {
	let transforms = 0;
	const { current, migrations, v1 } = defineChain(() => transforms++);
	const source = sourceSnapshot(v1.recordsSchemaHash, [
		{ kind: 'row', table: 'drafts', rowId: 'draft-1', cells: { body: 'x' } },
		{ kind: 'row', table: 'labels', rowId: 'label-1', cells: { name: 'Work' } },
		{ kind: 'row', table: 'notes', rowId: 'note-1', cells: { title: 'Keep' } },
		{ kind: 'row', table: 'notes', rowId: 'note-2', cells: { title: 'omit' } },
	]);

	const rows = await collect(runRecordsMigration({ migrations, source }));

	expect(rows).toEqual([
		{ table: 'labels', rowId: 'label-1', cells: { name: 'Work' } },
		{
			table: 'notes',
			rowId: 'note-1',
			cells: { title: 'Keep', slug: 'keep', pinned: false },
		},
	]);
	expect(rows.every((row) => row.table !== 'folders')).toBe(true);
	expect(source.scans).toBe(2);
	expect(transforms).toBe(2);
	expect(current.recordsSchemaHash).toBe(migrations[1].to.recordsSchemaHash);
});

test('intermediate source selects only the remaining adjacent suffix', async () => {
	let firstStepTransforms = 0;
	const { migrations, v2 } = defineChain(() => firstStepTransforms++);
	const source = sourceSnapshot(v2.recordsSchemaHash, [
		{
			kind: 'row',
			table: 'notes',
			rowId: 'note-v2',
			cells: { title: 'Existing', slug: 'existing' },
		},
	]);

	expect(await collect(runRecordsMigration({ migrations, source }))).toEqual([
		{
			table: 'notes',
			rowId: 'note-v2',
			cells: { title: 'Existing', slug: 'existing', pinned: false },
		},
	]);
	expect(firstStepTransforms).toBe(0);
});

test('nonconforming and quarantined rows block every transform with bounded identities', async () => {
	let transforms = 0;
	const { migrations, v1 } = defineChain(() => transforms++);
	const entries: RecordsMigrationSourceEntry[] = [
		{ kind: 'row', table: 'notes', rowId: 'bad', cells: { title: 42 } },
		{ kind: 'quarantined', table: 'notes', rowId: 'quarantined' },
	];
	const source = sourceSnapshot(v1.recordsSchemaHash, entries);

	const error = await collect(runRecordsMigration({ migrations, source })).then(
		() => undefined,
		(cause: unknown) => cause,
	);

	expect(error).toBeInstanceOf(RecordsMigrationSourceBlockedError);
	expect(error).toMatchObject({
		blockedRowCount: 2,
		blockers: [
			{ table: 'notes', rowId: 'bad', reason: 'nonconforming' },
			{ table: 'notes', rowId: 'quarantined', reason: 'quarantined' },
		],
	});
	expect(transforms).toBe(0);
	expect(source.scans).toBe(1);
	expect(entries).toEqual([
		{ kind: 'row', table: 'notes', rowId: 'bad', cells: { title: 42 } },
		{ kind: 'quarantined', table: 'notes', rowId: 'quarantined' },
	]);
});

test('invalid adjacent output reports the preserved table and row id', async () => {
	const { current, v1 } = defineChain();
	const invalid = defineRecordsMigration({
		from: v1,
		to: current,
		discard: ['drafts'],
		transform: {
			notes: (() => ({
				title: 'bad',
				summary: null,
				slug: 'bad',
				pinned: 'not boolean',
			})) as never,
		},
	});
	const migrations = defineRecordsMigrations([invalid]);
	const source = sourceSnapshot(v1.recordsSchemaHash, [
		{ kind: 'row', table: 'notes', rowId: 'note-7', cells: { title: 'x' } },
	]);

	const error = await collect(runRecordsMigration({ migrations, source })).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(RecordsMigrationTargetValidationError);
	expect((error as Error).message).toContain('notes.note-7');
});

test('second scan advances only as the target stream is consumed', async () => {
	const { migrations, v1 } = defineChain();
	const entries: RecordsMigrationSourceEntry[] = Array.from(
		{ length: 1_000 },
		(_, index) => ({
			kind: 'row' as const,
			table: 'notes',
			rowId: String(index).padStart(4, '0'),
			cells: { title: `Note ${index}` },
		}),
	);
	let secondScanRows = 0;
	const source = sourceSnapshot(v1.recordsSchemaHash, entries, (scan) => {
		if (scan === 2) secondScanRows++;
	});
	const iterator = runRecordsMigration({ migrations, source })[
		Symbol.asyncIterator
	]();

	const first = await iterator.next();
	expect(first.done).toBe(false);
	expect(first.value?.rowId).toBe('0000');
	expect(secondScanRows).toBe(1);

	let emitted = 1;
	while (!(await iterator.next()).done) emitted++;
	expect(emitted).toBe(1_000);
	expect(secondScanRows).toBe(1_000);
});

test('unknown, current, and out-of-order sources are refused', async () => {
	const { current, migrations, v1 } = defineChain();
	expect(() =>
		runRecordsMigration({
			migrations,
			source: sourceSnapshot('sha256:unknown', []),
		}),
	).toThrow('does not contain source schema');
	expect(() =>
		runRecordsMigration({
			migrations,
			source: sourceSnapshot(current.recordsSchemaHash, []),
		}),
	).toThrow('already at the current schema');

	const error = await collect(
		runRecordsMigration({
			migrations,
			source: sourceSnapshot(v1.recordsSchemaHash, [
				{ kind: 'row', table: 'notes', rowId: 'b', cells: { title: 'B' } },
				{ kind: 'row', table: 'notes', rowId: 'a', cells: { title: 'A' } },
			]),
		}),
	).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toMatchObject({
		blockers: [{ table: 'notes', rowId: 'a', reason: 'out-of-order' }],
	});
});
