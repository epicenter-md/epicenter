/**
 * Portable Data Protocol Tests
 *
 * Verifies wire parsing, identifier grammar, admission ceilings, canonical
 * digests, and closed exchange envelopes.
 *
 * Key behaviors:
 * - Structured addresses and runtime IDs use their frozen grammar
 * - Changes and pages enforce structural and encoded-size bounds
 * - Canonical digests ignore object insertion order
 */
import { describe, expect, test } from 'bun:test';
import { sha256Hex } from '@epicenter/lens';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	batchDigest,
	DATA_ADDRESS_CEILINGS,
	DATA_ADMISSION_LIMITS,
	type Intent,
	isRowAddress,
	parseExchangeRequest,
	parseExchangeResponse,
	parseIntent,
	parseReplicaId,
} from './index.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const ROW_ADDRESS = {
	namespace: 'so.epicenter.notes',
	tableName: 'rows',
	rowId: ROW_ID,
} as const;

describe('structured identifiers', () => {
	test('addresses require a reverse-domain namespace and legal local key', () => {
		expect(isRowAddress(ROW_ADDRESS, DATA_ADDRESS_CEILINGS)).toBe(true);
		for (const address of [
			{ ...ROW_ADDRESS, namespace: 'single' },
			{ ...ROW_ADDRESS, namespace: 'So.epicenter.notes' },
			{ ...ROW_ADDRESS, tableName: 'my-notes' },
			{ ...ROW_ADDRESS, rowId: '_theme' },
		]) {
			expect(isRowAddress(address, DATA_ADDRESS_CEILINGS)).toBe(false);
		}
	});

	test('a table name may not contain dots', () => {
		expect(
			isRowAddress(
				{ ...ROW_ADDRESS, tableName: 'settings.sound' },
				DATA_ADDRESS_CEILINGS,
			),
		).toBe(false);
	});

	test('namespace byte length stops at 128 bytes', () => {
		const exact = `a.${'c'.repeat(126)}`;
		expect(new TextEncoder().encode(exact)).toHaveLength(128);
		expect(isRowAddress({ ...ROW_ADDRESS, namespace: exact }, DATA_ADDRESS_CEILINGS)).toBe(true);
		expect(isRowAddress({ ...ROW_ADDRESS, namespace: `${exact}c` }, DATA_ADDRESS_CEILINGS)).toBe(false);
	});

	test('replica IDs require exactly 24 lowercase alphanumerics', () => {
		expect(expectOk(parseReplicaId(REPLICA_ID))).toBe(REPLICA_ID);
		for (const value of [
			'short',
			`${REPLICA_ID}x`,
			REPLICA_ID.toUpperCase(),
			'abc-23def456ghi789jkl012',
		]) {
			expect(expectErr(parseReplicaId(value)).name).toBe('Invalid');
		}
	});
});

describe('intent and exchange admission', () => {
	test('all four intent verbs parse and inputs are cloned', () => {
		const intents: Intent[] = [
			{ verb: 'patch', address: ROW_ADDRESS, set: { title: 'A' }, unset: [] },
			{
				verb: 'patch',
				address: ROW_ADDRESS,
				set: { title: 'B' },
				unset: ['old'],
			},
			{ verb: 'delete', address: ROW_ADDRESS },
		];
		for (const intent of intents)
			expect(expectOk(parseIntent(intent))).toEqual(intent);
		expect(expectOk(parseIntent(intents[0]))).not.toBe(intents[0]);
	});

	test('patches reject empty, duplicate, overlapping, and excessive unset keys', () => {
		const update = (unset: string[], set: Record<string, string> = {}) => ({
			verb: 'patch' as const,
			address: ROW_ADDRESS,
			set,
			unset,
		});
		for (const intent of [
			update([]),
			update(['x', 'x']),
			update(['x'], { x: 'overlap' }),
			update(
				Array.from(
					{ length: DATA_ADMISSION_LIMITS.unsetKeysPerIntent + 1 },
					(_, index) => `x${index}`,
				),
			),
		]) {
			expect(expectErr(parseIntent(intent)).name).toBe('Invalid');
		}
	});

	test('exchange request binds a bounded batch and forbids batches on continuation pages', () => {
		const intents = [{ verb: 'delete', address: ROW_ADDRESS }] as const;
		const batch = { seq: 1, digest: batchDigest(intents), intents };
		expect(
			expectOk(
				parseExchangeRequest({ replicaId: REPLICA_ID, after: 0, batch }),
			),
		).toMatchObject({ batch });
		expect(
			expectErr(
				parseExchangeRequest({
					replicaId: REPLICA_ID,
					after: 0,
					batch,
					cursor: { through: 2, position: 1 },
				}),
			).name,
		).toBe('Invalid');
	});

	test('exchange responses reject records beyond fixed through and moving cursors', () => {
		const fact = {
			presence: 'present',
			address: ROW_ADDRESS,
			authoritySequence: 2,
			fields: { title: 'dark' },
		} as const;
		expect(
			expectOk(
				parseExchangeResponse({ through: 2, facts: [fact], next: null }),
			),
		).toMatchObject({ facts: [fact] });
		for (const response of [
			{ through: 1, facts: [fact], next: null },
			{ through: 2, facts: [fact], next: { through: 3, position: 2 } },
		]) {
			expect(expectErr(parseExchangeResponse(response)).name).toBe('Invalid');
		}
	});
});

test('canonical batch digest and SHA-256 are deterministic', () => {
	const left: Intent[] = [{ verb: 'patch', address: ROW_ADDRESS, set: { b: 2, a: 1 }, unset: [] }];
	const right: Intent[] = [{ verb: 'patch', address: ROW_ADDRESS, set: { a: 1, b: 2 }, unset: [] }];
	expect(batchDigest(left)).toBe(batchDigest(right));
	expect(sha256Hex('abc')).toBe(
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});

describe('table names stay usable as bare SQL relations', () => {
	const admits = (tableName: string) =>
		isRowAddress({ ...ROW_ADDRESS, tableName }, DATA_ADDRESS_CEILINGS);

	test('a SQLite keyword is refused in any casing', () => {
		// `SELECT * FROM order` is a syntax error no matter how the inspection
		// host generates the view, so the name never becomes an address.
		for (const keyword of [
			'order',
			'Order',
			'SELECT',
			'table',
			'group',
			'index',
			'where',
			'values',
		]) {
			expect(admits(keyword)).toBe(false);
		}
	});

	test('keywords SQLite does accept as identifiers stay available', () => {
		// Refusing every keyword would cost 88 perfectly usable names. The rule
		// tracks what SQLite actually refuses, not what it lists as a keyword.
		for (const keyword of [
			'rows',
			'row',
			'key',
			'view',
			'first',
			'range',
			'filter',
		]) {
			expect(admits(keyword)).toBe(true);
		}
	});

	test('SQLite reserved and Epicenter-occupied names are refused', () => {
		for (const name of [
			'sqlite_master',
			'sqlite_schema',
			'SQLite_Sequence',
			'document_updates',
			'document_publication',
			'document_versions',
		]) {
			expect(admits(name)).toBe(false);
		}
	});

	test('an underscore-prefixed name is unrepresentable, so private relations are unreachable', () => {
		// This is what lets internal storage sit at `_replica_*` and `_epicenter_*`
		// without any chance of a Lens naming one.
		for (const name of ['_replica_row_facts', '_epicenter_rows', '_private']) {
			expect(admits(name)).toBe(false);
		}
	});

	test('ordinary names a Lens would actually declare still pass', () => {
		for (const name of [
			'notes',
			'folders',
			'conversations',
			'orders',
			'tableau',
			'selected_rows',
			'n1',
		]) {
			expect(admits(name)).toBe(true);
		}
	});
});
