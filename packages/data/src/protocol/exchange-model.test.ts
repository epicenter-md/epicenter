/**
 * Fixed-Through Exchange Protocol Model Tests
 *
 * Adopts the proven pagination model using the real Data intent, fact,
 * cursor, digest, and fold vocabulary.
 *
 * Key behaviors:
 * - Fixed-through pagination cannot skip a current fact inside its window
 * - Batch and fact retries are idempotent
 * - Durable cursors advance only after the final page installs
 */
import { describe, expect, test } from 'bun:test';

import {
	batchDigest,
	type Cursor,
	type Fact,
	foldIntent,
	type Intent,
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

function addressOf(value: Intent | Fact): string {
	return JSON.stringify(value.address);
}

function createAuthority() {
	let maximumSequence = 0;
	let appliedIntentCount = 0;
	const state = new Map<string, Fact>();
	const batches = new Map<
		string,
		{ seq: number; digest: string; appliedThrough: number }
	>();

	function submit(intent: Intent) {
		const address = addressOf(intent);
		const folded = foldIntent(state.get(address), intent, maximumSequence + 1);
		if (folded.kind === 'applied') {
			maximumSequence += 1;
			appliedIntentCount += 1;
			state.set(address, structuredClone(folded.fact));
		}
		return folded;
	}

	function applyBatch(replicaId: string, seq: number, intents: Intent[]) {
		const digest = batchDigest(intents);
		const prior = batches.get(replicaId);
		if (prior?.seq === seq && prior.digest === digest) return prior;
		if (seq !== (prior?.seq ?? 0) + 1) throw new Error('batch-conflict');
		for (const intent of intents) submit(intent);
		const receipt = { seq, digest, appliedThrough: maximumSequence };
		batches.set(replicaId, receipt);
		return receipt;
	}

	function page(after: number, cursor: Cursor | undefined, pageSize: number) {
		const through = cursor?.through ?? maximumSequence;
		const position = cursor?.position ?? after;
		const eligible = [...state.values()]
			.filter(
				(fact) =>
					fact.authoritySequence > position &&
					fact.authoritySequence <= through,
			)
			.sort((left, right) => left.authoritySequence - right.authoritySequence);
		const facts = eligible
			.slice(0, pageSize)
			.map((fact) => structuredClone(fact));
		const next =
			eligible.length > pageSize
				? { through, position: facts.at(-1)?.authoritySequence ?? position }
				: null;
		return { through, facts, next };
	}

	return {
		submit,
		applyBatch,
		page,
		get maximumSequence() {
			return maximumSequence;
		},
		get appliedIntentCount() {
			return appliedIntentCount;
		},
		get(address: string) {
			const fact = state.get(address);
			return fact === undefined ? undefined : structuredClone(fact);
		},
		facts() {
			return [...state.values()].map((fact) => structuredClone(fact));
		},
	};
}

function createClient(after = 0) {
	let durableAfter = after;
	let installEffectCount = 0;
	const state = new Map<string, Fact>();
	const installed = new Set<string>();
	return {
		get durableAfter() {
			return durableAfter;
		},
		get installEffectCount() {
			return installEffectCount;
		},
		install(facts: Fact[]) {
			for (const fact of facts) {
				const effect = `${addressOf(fact)}\0${fact.authoritySequence}`;
				if (installed.has(effect)) continue;
				installed.add(effect);
				installEffectCount += 1;
				const address = addressOf(fact);
				const current = state.get(address);
				if (
					current === undefined ||
					current.authoritySequence < fact.authoritySequence
				) {
					state.set(address, structuredClone(fact));
				}
			}
		},
		complete(through: number) {
			durableAfter = through;
		},
		get(address: string) {
			return state.get(address);
		},
		facts() {
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
	const returned: Fact[] = [];
	while (true) {
		const page = authority.page(client.durableAfter, cursor, pageSize);
		client.install(page.facts);
		returned.push(...page.facts);
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
	test('1. bounded writer orders and mid-page overwrites never skip current in-window facts', () => {
		const keys = ['a', 'b', 'c'];
		for (const order of permutations(keys)) {
			for (const overwritten of [undefined, ...keys]) {
				const authority = createAuthority();
				const client = createClient();
				for (const key of order)
					authority.submit({
						verb: 'set',
						address: valueAddress(key),
						content: key,
					});
				const through = authority.maximumSequence;
				let cursor: Cursor | undefined;
				const returned: Fact[] = [];
				let pageNumber = 0;
				while (true) {
					const page = authority.page(0, cursor, 1);
					client.install(page.facts);
					returned.push(...page.facts);
					pageNumber += 1;
					if (pageNumber === 1 && overwritten !== undefined) {
						authority.submit({
							verb: 'set',
							address: valueAddress(overwritten),
							content: 'new',
						});
					}
					if (page.next === null) break;
					cursor = page.next;
				}
				client.complete(through);
				for (const current of authority.facts()) {
					if (current.authoritySequence <= through) {
						expect(
							returned.some(
								(fact) =>
									addressOf(fact) === addressOf(current) &&
									fact.authoritySequence === current.authoritySequence,
							),
						).toBe(true);
					} else {
						expect(current.authoritySequence).toBeGreaterThan(through);
					}
				}
				drain(authority, client, 1);
				expect(client.facts()).toEqual(
					authority
						.facts()
						.sort((left, right) =>
							addressOf(left).localeCompare(addressOf(right)),
						),
				);
			}
		}
	});

	test('2. an early-page fact overwritten above through appears next exchange', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({
			verb: 'set',
			address: valueAddress('a'),
			content: 'a1',
		});
		authority.submit({
			verb: 'set',
			address: valueAddress('b'),
			content: 'b1',
		});
		const first = authority.page(0, undefined, 1);
		client.install(first.facts);
		authority.submit({
			verb: 'set',
			address: valueAddress('a'),
			content: 'a2',
		});
		const last = authority.page(0, first.next ?? undefined, 1);
		client.install(last.facts);
		client.complete(last.through);
		const current = authority.get(JSON.stringify(valueAddress('a')));
		if (current === undefined) throw new Error('Expected current value');
		expect(drain(authority, client, 1)).toEqual([current]);
	});

	test('3. retrying an identical local batch returns one receipt and applies once', () => {
		const authority = createAuthority();
		const intents: Intent[] = [
			{ verb: 'set', address: valueAddress('a'), content: 'a1' },
		];
		const receipt = authority.applyBatch(REPLICA_ID, 1, intents);
		expect(authority.applyBatch(REPLICA_ID, 1, intents)).toBe(receipt);
		expect(authority.appliedIntentCount).toBe(1);
	});

	test('4. a fresh replica receives all current live, tombstone, and unset facts', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({
			verb: 'patch',
			address: rowAddress(ROW_ID),
			set: { title: 'live' },
			unset: [],
		});
		authority.submit({
			verb: 'patch',
			address: rowAddress('bbbbbbbbbbbbbbbbbbbbbbbb'),
			set: {},
			unset: [],
		});
		authority.submit({
			verb: 'delete',
			address: rowAddress('bbbbbbbbbbbbbbbbbbbbbbbb'),
		});
		authority.submit({
			verb: 'set',
			address: valueAddress('value'),
			content: 1,
		});
		authority.submit({ verb: 'unset', address: valueAddress('value') });
		drain(authority, client, 2);
		expect(client.facts()).toEqual(
			authority
				.facts()
				.sort((left, right) => addressOf(left).localeCompare(addressOf(right))),
		);
	});

	test('5. a terminal tombstone defeats offline create and update attempts', () => {
		const authority = createAuthority();
		authority.submit({
			verb: 'patch',
			address: rowAddress(ROW_ID),
			set: {},
			unset: [],
		});
		authority.submit({ verb: 'delete', address: rowAddress(ROW_ID) });
		const afterDelete = authority.maximumSequence;
		expect(
			authority.submit({
				verb: 'patch',
				address: rowAddress(ROW_ID),
				set: { stale: true },
				unset: [],
			}).kind,
		).toBe('noop');
		expect(
			authority.submit({
				verb: 'patch',
				address: rowAddress(ROW_ID),
				set: { stale: true },
				unset: [],
			}).kind,
		).toBe('noop');
		expect(authority.maximumSequence).toBe(afterDelete);
	});

	test('6. retry from an old cursor reinstalls pages without duplicate effects', () => {
		const authority = createAuthority();
		const client = createClient();
		const intents: Intent[] = [
			{ verb: 'set', address: valueAddress('a'), content: 1 },
			{ verb: 'set', address: valueAddress('b'), content: 2 },
		];
		authority.applyBatch(REPLICA_ID, 1, intents);
		const first = authority.page(0, undefined, 1);
		client.install(first.facts);
		expect(client.durableAfter).toBe(0);
		authority.applyBatch(REPLICA_ID, 1, intents);
		drain(authority, client, 1);
		expect(client.installEffectCount).toBe(2);
		expect(authority.appliedIntentCount).toBe(2);
	});

	test('7. repeated boundary crossings neither duplicate forever nor lose latest forever', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({
			verb: 'set',
			address: valueAddress('other'),
			content: 1,
		});
		authority.submit({
			verb: 'set',
			address: valueAddress('boundary'),
			content: 1,
		});
		const first = authority.page(0, undefined, 1);
		client.install(first.facts);
		authority.submit({
			verb: 'set',
			address: valueAddress('boundary'),
			content: 2,
		});
		const last = authority.page(0, first.next ?? undefined, 1);
		client.install(last.facts);
		client.complete(last.through);
		const current = authority.get(JSON.stringify(valueAddress('boundary')));
		if (current === undefined)
			throw new Error('Expected current boundary value');
		expect(drain(authority, client, 1)).toEqual([current]);
	});

	test('8. continuous replacement cannot prevent fixed-through progress', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({ verb: 'set', address: valueAddress('hot'), content: 0 });
		let prior = 0;
		for (let index = 1; index <= 8; index += 1) {
			const through = authority.maximumSequence;
			authority.submit({
				verb: 'set',
				address: valueAddress('hot'),
				content: index,
			});
			const page = authority.page(
				client.durableAfter,
				{ through, position: client.durableAfter },
				1,
			);
			expect(page.facts).toEqual([]);
			client.complete(through);
			expect(client.durableAfter).toBeGreaterThan(prior);
			prior = through;
		}
		expect(drain(authority, client, 1)).toHaveLength(1);
	});

	test('9. one last receipt accepts exact retry and rejects gaps or old batches', () => {
		const authority = createAuthority();
		const first: Intent[] = [
			{ verb: 'set', address: valueAddress('a'), content: 1 },
		];
		const second: Intent[] = [
			{ verb: 'set', address: valueAddress('b'), content: 2 },
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
