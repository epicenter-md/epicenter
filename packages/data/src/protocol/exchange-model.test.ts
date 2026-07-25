/**
 * Fixed-Through Exchange Protocol Model Tests
 *
 * Adopts the proven pagination model using the real Data change, record,
 * cursor, digest, and fold vocabulary.
 *
 * Key behaviors:
 * - Fixed-through pagination cannot skip a current record inside its window
 * - Batch and record retries are idempotent
 * - Durable cursors advance only after the final page installs
 */
import { describe, expect, test } from 'bun:test';

import {
	batchDigest,
	type Change,
	type Cursor,
	foldChange,
	type Record as SyncRecord,
} from './index.js';

const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

function rowAddress(rowId: string) {
	return {
		kind: 'row',
		namespace: 'so.epicenter.model',
		tableName: 'rows',
		rowId,
	} as const;
}

function valueAddress(valueName: string) {
	return {
		kind: 'value',
		namespace: 'so.epicenter.model',
		valueName,
	} as const;
}

function addressOf(value: Change | SyncRecord): string {
	return JSON.stringify(value.address);
}

function createAuthority() {
	let maximumSequence = 0;
	let appliedChangeCount = 0;
	const state = new Map<string, SyncRecord>();
	const batches = new Map<
		string,
		{ seq: number; digest: string; appliedThrough: number }
	>();

	function submit(change: Change) {
		const address = addressOf(change);
		const folded = foldChange(state.get(address), change, maximumSequence + 1);
		if (folded.kind === 'applied') {
			maximumSequence += 1;
			appliedChangeCount += 1;
			state.set(address, structuredClone(folded.record));
		}
		return folded;
	}

	function applyBatch(replicaId: string, seq: number, changes: Change[]) {
		const digest = batchDigest(changes);
		const prior = batches.get(replicaId);
		if (prior?.seq === seq && prior.digest === digest) return prior;
		if (seq !== (prior?.seq ?? 0) + 1) throw new Error('batch-conflict');
		for (const change of changes) submit(change);
		const receipt = { seq, digest, appliedThrough: maximumSequence };
		batches.set(replicaId, receipt);
		return receipt;
	}

	function page(after: number, cursor: Cursor | undefined, pageSize: number) {
		const through = cursor?.through ?? maximumSequence;
		const position = cursor?.position ?? after;
		const eligible = [...state.values()]
			.filter(
				(record) =>
					record.changedSequence > position &&
					record.changedSequence <= through,
			)
			.sort((left, right) => left.changedSequence - right.changedSequence);
		const records = eligible
			.slice(0, pageSize)
			.map((record) => structuredClone(record));
		const next =
			eligible.length > pageSize
				? { through, position: records.at(-1)?.changedSequence ?? position }
				: null;
		return { through, records, next };
	}

	return {
		submit,
		applyBatch,
		page,
		get maximumSequence() {
			return maximumSequence;
		},
		get appliedChangeCount() {
			return appliedChangeCount;
		},
		get(address: string) {
			const record = state.get(address);
			return record === undefined ? undefined : structuredClone(record);
		},
		records() {
			return [...state.values()].map((record) => structuredClone(record));
		},
	};
}

function createClient(after = 0) {
	let durableAfter = after;
	let installEffectCount = 0;
	const state = new Map<string, SyncRecord>();
	const installed = new Set<string>();
	return {
		get durableAfter() {
			return durableAfter;
		},
		get installEffectCount() {
			return installEffectCount;
		},
		install(records: SyncRecord[]) {
			for (const record of records) {
				const effect = `${addressOf(record)}\0${record.changedSequence}`;
				if (installed.has(effect)) continue;
				installed.add(effect);
				installEffectCount += 1;
				const address = addressOf(record);
				const current = state.get(address);
				if (
					current === undefined ||
					current.changedSequence < record.changedSequence
				) {
					state.set(address, structuredClone(record));
				}
			}
		},
		complete(through: number) {
			durableAfter = through;
		},
		get(address: string) {
			return state.get(address);
		},
		records() {
			return [...state.values()].sort((left, right) =>
				addressOf(left).localeCompare(addressOf(right)),
			);
		},
	};
}

function drain(
	authority: ReturnType<typeof createAuthority>,
	client: ReturnType<typeof createClient>,
	pageSize: number,
) {
	let cursor: Cursor | undefined;
	const returned: SyncRecord[] = [];
	while (true) {
		const page = authority.page(client.durableAfter, cursor, pageSize);
		client.install(page.records);
		returned.push(...page.records);
		if (page.next === null) {
			client.complete(page.through);
			return returned;
		}
		cursor = page.next;
	}
}

function permutations<T>(values: T[]): T[][] {
	if (values.length === 0) return [[]];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, candidate) => candidate !== index)).map(
			(rest) => [value, ...rest],
		),
	);
}

describe('fixed-through latest-state exchange', () => {
	test('1. bounded writer orders and mid-page overwrites never skip current in-window records', () => {
		const keys = ['a', 'b', 'c'];
		for (const order of permutations(keys)) {
			for (const overwritten of [undefined, ...keys]) {
				const authority = createAuthority();
				const client = createClient();
				for (const key of order)
					authority.submit({
						kind: 'set',
						address: valueAddress(key),
						value: key,
					});
				const through = authority.maximumSequence;
				let cursor: Cursor | undefined;
				const returned: SyncRecord[] = [];
				let pageNumber = 0;
				while (true) {
					const page = authority.page(0, cursor, 1);
					client.install(page.records);
					returned.push(...page.records);
					pageNumber += 1;
					if (pageNumber === 1 && overwritten !== undefined) {
						authority.submit({
							kind: 'set',
							address: valueAddress(overwritten),
							value: 'new',
						});
					}
					if (page.next === null) break;
					cursor = page.next;
				}
				client.complete(through);
				for (const current of authority.records()) {
					if (current.changedSequence <= through) {
						expect(
							returned.some(
								(record) =>
									addressOf(record) === addressOf(current) &&
									record.changedSequence === current.changedSequence,
							),
						).toBe(true);
					} else {
						expect(current.changedSequence).toBeGreaterThan(through);
					}
				}
				drain(authority, client, 1);
				expect(client.records()).toEqual(
					authority
						.records()
						.sort((left, right) =>
							addressOf(left).localeCompare(addressOf(right)),
						),
				);
			}
		}
	});

	test('2. an early-page record overwritten above through appears next exchange', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({ kind: 'set', address: valueAddress('a'), value: 'a1' });
		authority.submit({ kind: 'set', address: valueAddress('b'), value: 'b1' });
		const first = authority.page(0, undefined, 1);
		client.install(first.records);
		authority.submit({ kind: 'set', address: valueAddress('a'), value: 'a2' });
		const last = authority.page(0, first.next ?? undefined, 1);
		client.install(last.records);
		client.complete(last.through);
		const current = authority.get(JSON.stringify(valueAddress('a')));
		if (current === undefined) throw new Error('Expected current value');
		expect(drain(authority, client, 1)).toEqual([current]);
	});

	test('3. retrying an identical local batch returns one receipt and applies once', () => {
		const authority = createAuthority();
		const changes: Change[] = [
			{ kind: 'set', address: valueAddress('a'), value: 'a1' },
		];
		const receipt = authority.applyBatch(REPLICA_ID, 1, changes);
		expect(authority.applyBatch(REPLICA_ID, 1, changes)).toBe(receipt);
		expect(authority.appliedChangeCount).toBe(1);
	});

	test('4. a fresh replica receives all current live, tombstone, and unset records', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({
			kind: 'create',
			address: rowAddress(ROW_ID),
			fields: { title: 'live' },
		});
		authority.submit({
			kind: 'create',
			address: rowAddress('bbbbbbbbbbbbbbbbbbbbbbbb'),
			fields: {},
		});
		authority.submit({
			kind: 'delete',
			address: rowAddress('bbbbbbbbbbbbbbbbbbbbbbbb'),
		});
		authority.submit({
			kind: 'set',
			address: valueAddress('value'),
			value: 1,
		});
		authority.submit({ kind: 'unset', address: valueAddress('value') });
		drain(authority, client, 2);
		expect(client.records()).toEqual(
			authority
				.records()
				.sort((left, right) => addressOf(left).localeCompare(addressOf(right))),
		);
	});

	test('5. a terminal tombstone defeats offline create and update attempts', () => {
		const authority = createAuthority();
		authority.submit({
			kind: 'create',
			address: rowAddress(ROW_ID),
			fields: {},
		});
		authority.submit({ kind: 'delete', address: rowAddress(ROW_ID) });
		const afterDelete = authority.maximumSequence;
		expect(
			authority.submit({
				kind: 'create',
				address: rowAddress(ROW_ID),
				fields: { stale: true },
			}).kind,
		).toBe('noop');
		expect(
			authority.submit({
				kind: 'update',
				address: rowAddress(ROW_ID),
				fields: { set: { stale: true }, unset: [] },
			}).kind,
		).toBe('noop');
		expect(authority.maximumSequence).toBe(afterDelete);
	});

	test('6. retry from an old cursor reinstalls pages without duplicate effects', () => {
		const authority = createAuthority();
		const client = createClient();
		const changes: Change[] = [
			{ kind: 'set', address: valueAddress('a'), value: 1 },
			{ kind: 'set', address: valueAddress('b'), value: 2 },
		];
		authority.applyBatch(REPLICA_ID, 1, changes);
		const first = authority.page(0, undefined, 1);
		client.install(first.records);
		expect(client.durableAfter).toBe(0);
		authority.applyBatch(REPLICA_ID, 1, changes);
		drain(authority, client, 1);
		expect(client.installEffectCount).toBe(2);
		expect(authority.appliedChangeCount).toBe(2);
	});

	test('7. repeated boundary crossings neither duplicate forever nor lose latest forever', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({
			kind: 'set',
			address: valueAddress('other'),
			value: 1,
		});
		authority.submit({
			kind: 'set',
			address: valueAddress('boundary'),
			value: 1,
		});
		const first = authority.page(0, undefined, 1);
		client.install(first.records);
		authority.submit({
			kind: 'set',
			address: valueAddress('boundary'),
			value: 2,
		});
		const last = authority.page(0, first.next ?? undefined, 1);
		client.install(last.records);
		client.complete(last.through);
		const current = authority.get(JSON.stringify(valueAddress('boundary')));
		if (current === undefined)
			throw new Error('Expected current boundary value');
		expect(drain(authority, client, 1)).toEqual([current]);
	});

	test('8. continuous replacement cannot prevent fixed-through progress', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({ kind: 'set', address: valueAddress('hot'), value: 0 });
		let prior = 0;
		for (let index = 1; index <= 8; index += 1) {
			const through = authority.maximumSequence;
			authority.submit({
				kind: 'set',
				address: valueAddress('hot'),
				value: index,
			});
			const page = authority.page(
				client.durableAfter,
				{ through, position: client.durableAfter },
				1,
			);
			expect(page.records).toEqual([]);
			client.complete(through);
			expect(client.durableAfter).toBeGreaterThan(prior);
			prior = through;
		}
		expect(drain(authority, client, 1)).toHaveLength(1);
	});

	test('9. one last receipt accepts exact retry and rejects gaps or old batches', () => {
		const authority = createAuthority();
		const first: Change[] = [
			{ kind: 'set', address: valueAddress('a'), value: 1 },
		];
		const second: Change[] = [
			{ kind: 'set', address: valueAddress('b'), value: 2 },
		];
		authority.applyBatch(REPLICA_ID, 1, first);
		authority.applyBatch(REPLICA_ID, 2, second);
		expect(() => authority.applyBatch(REPLICA_ID, 1, first)).toThrow(
			'batch-conflict',
		);
		expect(() =>
			authority.applyBatch('ssssssssssssssssssssssss', 2, second),
		).toThrow('batch-conflict');
	});
});
