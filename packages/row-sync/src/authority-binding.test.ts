/**
 * Row Authority Binding Tests
 *
 * Verifies sealed-round folding, retry receipts, outcome paging, compaction,
 * and baseline scans against Bun SQLite.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from './adapters/bun.js';
import { ROW_SYNC_ADMISSION_LIMITS } from './admission.js';
import { type DocumentCodec, openRowAuthority } from './authority.js';
import {
	encodeBase64,
	ROW_SYNC_PROTOCOL_MAJOR,
	type SyncResponse,
	type WireRowIntent,
} from './protocol.js';
import { rowRoundDigest } from './round-digest.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A deterministic stand-in for the injected Yjs codec: an update is a JSON
 * array of tokens and the compact state is the sorted distinct union, so
 * merging is idempotent and compact size grows with distinct content.
 */
const codec: DocumentCodec = {
	isValidUpdate(update) {
		try {
			const value = JSON.parse(decoder.decode(update));
			return (
				Array.isArray(value) && value.every((token) => typeof token === 'string')
			);
		} catch {
			return false;
		}
	},
	mergedCompactState(parts) {
		const tokens = new Set<string>();
		for (const part of parts) {
			for (const token of JSON.parse(decoder.decode(part)) as string[]) {
				tokens.add(token);
			}
		}
		return encoder.encode(JSON.stringify([...tokens].sort()));
	},
};

const docUpdate = (...tokens: string[]) =>
	encodeBase64(encoder.encode(JSON.stringify(tokens)));

const rid = (n: number) => n.toString(36).padStart(24, '0');

function openTestAuthority() {
	const sqlite = new Database(':memory:');
	const authority = openRowAuthority({
		database: createBunSqliteAdapter(sqlite),
		codec,
	});
	const enrolled = authority.enroll({
		protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'enroll',
	});
	if (enrolled.result !== 'enrolled') throw new Error('Enrollment failed');
	const state = { replicaId: enrolled.replicaId, checkpoint: 0 };
	return {
		authority,
		replicaId: state.replicaId,
		sqlite,
		sync({
			round,
			intents,
			digest,
			checkpoint = 0,
			acceptedRound = round === undefined ? 0 : round - 1,
			pageLimit,
			replicaId = state.replicaId,
		}: {
			round?: number;
			intents?: WireRowIntent[];
			digest?: string;
			checkpoint?: number;
			acceptedRound?: number;
			pageLimit?: number;
			replicaId?: string;
		} = {}): SyncResponse {
			return authority.sync({
				protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'sync',
				token: { replicaId, acceptedRound, checkpoint },
				...(round === undefined
					? {}
					: {
							sealedRound: {
								round,
								requestDigest: digest ?? rowRoundDigest(intents ?? []),
								intents: intents ?? [],
							},
						}),
				...(pageLimit === undefined ? {} : { pageLimit }),
			});
		},
	};
}

function expectPage(
	response: SyncResponse,
): Extract<SyncResponse, { result: 'page' }> {
	if (response.result !== 'page') {
		throw new Error(`Expected a page, got ${JSON.stringify(response)}`);
	}
	return response;
}

const create = (
	rowId: string,
	fields: Record<string, unknown>,
	documentUpdate?: string,
): WireRowIntent => ({
	kind: 'create',
	table: 'notes',
	rowId,
	fields: fields as never,
	...(documentUpdate === undefined ? {} : { documentUpdate }),
});

const update = (
	rowId: string,
	fields?: { set: Record<string, unknown>; unset: string[] },
	documentUpdate?: string,
): WireRowIntent => ({
	kind: 'update',
	table: 'notes',
	rowId,
	...(fields === undefined ? {} : { fields: fields as never }),
	...(documentUpdate === undefined ? {} : { documentUpdate }),
});

const remove = (rowId: string): WireRowIntent => ({
	kind: 'delete',
	table: 'notes',
	rowId,
});

describe('enrollment (ADR-0131)', () => {
	test('enrollment mints a canonical replica identity at round zero', () => {
		const { authority, replicaId } = openTestAuthority();
		expect(replicaId).toMatch(/^[a-z0-9]{24}$/);
		expect(authority.inspect().replicas[replicaId]).toEqual({
			acceptedRound: 0,
		});
	});

	test('ordinary sync refuses an unseen client-supplied replica id', () => {
		const { sync } = openTestAuthority();
		expect(sync({ replicaId: 'somebodyelse000000000000' })).toEqual({
			result: 'unknown-replica',
		});
	});
});

describe('RowIntent lifecycle and composite outcomes (ADR-0131/0133)', () => {
	test('create with fields and document emits one composite outcome', () => {
		const { sync, replicaId } = openTestAuthority();
		const page = expectPage(
			sync({
				round: 1,
				intents: [create(rid(1), { title: 'a' }, docUpdate('t1'))],
			}),
		);
		expect(page.token).toEqual({ replicaId, acceptedRound: 1, checkpoint: 1 });
		expect(page.outcomes).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: rid(1),
				fields: { title: 'a' },
				documentUpdate: docUpdate('t1'),
				sequence: 1,
			},
		]);
	});

	test('field and document components of a live update fold independently', () => {
		const { sync } = openTestAuthority();
		sync({ round: 1, intents: [create(rid(1), { title: 'a' })] });
		const page = expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [
					update(rid(1), { set: { title: 'b' }, unset: [] }, docUpdate('t1')),
				],
			}),
		);
		expect(page.outcomes).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: rid(1),
				fields: { title: 'b' },
				documentUpdate: docUpdate('t1'),
				sequence: 2,
			},
		]);
	});

	test('delete removes fields and all document state in one transaction', () => {
		const { authority, sync } = openTestAuthority();
		sync({
			round: 1,
			intents: [create(rid(1), { title: 'a' }, docUpdate('t1'))],
		});
		const page = expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [remove(rid(1))],
			}),
		);
		expect(page.outcomes).toEqual([
			{ kind: 'deletion', table: 'notes', rowId: rid(1), sequence: 2 },
		]);
		const inspected = authority.inspect();
		expect(inspected.rows).toEqual([]);
		expect(inspected.documentUpdates).toEqual([]);
		expect(inspected.documentBaselines).toEqual([]);
	});

	test('late document updates for a dead address no-op forever', () => {
		const { authority, sync } = openTestAuthority();
		sync({ round: 1, intents: [create(rid(1), { title: 'a' })] });
		sync({
			round: 2,
			acceptedRound: 1,
			intents: [remove(rid(1))],
		});
		const page = expectPage(
			sync({
				round: 3,
				acceptedRound: 2,
				checkpoint: 2,
				intents: [update(rid(1), undefined, docUpdate('late'))],
			}),
		);
		// The no-op consumed sequence 3 without emitting a row fact; the
		// checkpoint advances across the gap.
		expect(page.outcomes).toEqual([]);
		expect(page.token.checkpoint).toBe(3);
		expect(authority.inspect().documentUpdates).toEqual([]);
	});

	test('create on a live address no-ops as a whole', () => {
		const { authority, sync } = openTestAuthority();
		sync({
			round: 1,
			intents: [create(rid(1), { title: 'first' }, docUpdate('t1'))],
		});
		expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				intents: [create(rid(1), { title: 'second' }, docUpdate('t2'))],
			}),
		);
		const inspected = authority.inspect();
		expect(inspected.rows).toEqual([
			{
				table: 'notes',
				rowId: rid(1),
				fields: { title: 'first' },
				sequence: 1,
			},
		]);
		expect(inspected.documentUpdates).toEqual([
			{ table: 'notes', rowId: rid(1), sequence: 1 },
		]);
	});
});

describe('merge-aware document admission (ADR-0131/0133)', () => {
	const bigToken = (name: string) =>
		`${name}:${'x'.repeat(
			Math.ceil(ROW_SYNC_ADMISSION_LIMITS.canonicalDocumentBytes * 0.6),
		)}`;
	const malformedUpdate = encodeBase64(new Uint8Array([1, 2, 3]));

	test('malformed document bytes no-op without wedging the sealed round', () => {
		const { authority, replicaId, sync } = openTestAuthority();
		const created = expectPage(
			sync({
				round: 1,
				intents: [create(rid(1), { title: 'invalid' }, malformedUpdate)],
			}),
		);
		expect(created.token).toEqual({
			replicaId,
			acceptedRound: 1,
			checkpoint: 1,
		});
		expect(created.outcomes).toEqual([]);
		expect(authority.inspect().rows).toEqual([]);

		expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [create(rid(1), { title: 'valid' })],
			}),
		);
		expect(authority.inspect().rows[0]?.fields).toEqual({ title: 'valid' });
	});

	test('malformed document bytes no-op only the live update component', () => {
		const { authority, sync } = openTestAuthority();
		sync({ round: 1, intents: [create(rid(1), { title: 'before' })] });
		const page = expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [
					update(
						rid(1),
						{ set: { title: 'after' }, unset: [] },
						malformedUpdate,
					),
				],
			}),
		);
		expect(page.outcomes).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: rid(1),
				fields: { title: 'after' },
				sequence: 2,
			},
		]);
		expect(authority.inspect().documentUpdates).toEqual([]);
	});

	test('a merged document above the canonical maximum no-ops only the document component', () => {
		const { authority, sync } = openTestAuthority();
		sync({
			round: 1,
			intents: [create(rid(1), { title: 'a' }, docUpdate(bigToken('a')))],
		});
		const page = expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [
					update(
						rid(1),
						{ set: { title: 'b' }, unset: [] },
						docUpdate(bigToken('b')),
					),
				],
			}),
		);
		// The scalar component still applies; the document component no-ops.
		expect(page.outcomes).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: rid(1),
				fields: { title: 'b' },
				sequence: 2,
			},
		]);
		expect(authority.inspect().documentUpdates).toEqual([
			{ table: 'notes', rowId: rid(1), sequence: 1 },
		]);
	});

	test('an admissible document merge appends even when fields no-op on capacity', () => {
		const { authority, sync } = openTestAuthority();
		sync({ round: 1, intents: [create(rid(1), { title: 'a' })] });
		const oversizedFields = {
			set: { big: 'x'.repeat(ROW_SYNC_ADMISSION_LIMITS.encodedRowBytes) },
			unset: [],
		};
		const page = expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [update(rid(1), oversizedFields, docUpdate('t1'))],
			}),
		);
		expect(page.outcomes).toEqual([
			{
				kind: 'row',
				table: 'notes',
				rowId: rid(1),
				documentUpdate: docUpdate('t1'),
				sequence: 2,
			},
		]);
		expect(authority.inspect().rows[0]?.fields).toEqual({ title: 'a' });
	});

	test('a create whose initial document exceeds the maximum no-ops as a whole', () => {
		const { authority, sync } = openTestAuthority();
		const oversized = docUpdate(bigToken('a'), bigToken('b'));
		expectPage(
			sync({ round: 1, intents: [create(rid(1), { title: 'a' }, oversized)] }),
		);
		expect(authority.inspect().rows).toEqual([]);
		expect(authority.inspect().documentUpdates).toEqual([]);
	});
});

describe('exact retry and the terminal fork rule (ADR-0131)', () => {
	test('a lost accepted response retries without refolding', () => {
		const { authority, sync } = openTestAuthority();
		const intents = [create(rid(1), { count: 1 })];
		expectPage(sync({ round: 1, intents }));
		const headBefore = authority.inspect().head;
		// The identical image retries idempotently: the receipt's round and
		// digest alone decide it, and nothing refolds.
		const retried = expectPage(sync({ round: 1, intents }));
		expect(retried.token.acceptedRound).toBe(1);
		expect(authority.inspect().head).toBe(headBefore);
		expect(authority.inspect().rows).toHaveLength(1);
	});

	test('a digest mismatch on the accepted round is a terminal fork', () => {
		const { sync } = openTestAuthority();
		sync({ round: 1, intents: [create(rid(1), { count: 1 })] });
		expect(
			sync({
				round: 1,
				intents: [create(rid(2), { count: 2 })],
			}),
		).toEqual({ result: 'replica-fork' });
	});

	test('a round that is neither accepted nor its successor is a terminal fork', () => {
		const { sync } = openTestAuthority();
		sync({ round: 1, intents: [create(rid(1), { count: 1 })] });
		expect(
			sync({
				round: 3,
				acceptedRound: 1,
				intents: [create(rid(2), { count: 2 })],
			}),
		).toEqual({ result: 'replica-fork' });
	});

	test('a late duplicate of a superseded round forks without mutating anything', () => {
		const { authority, sync } = openTestAuthority();
		const first = [create(rid(1), { count: 1 })];
		expectPage(sync({ round: 1, intents: first }));
		expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				checkpoint: 1,
				intents: [create(rid(2), { count: 2 })],
			}),
		);
		const before = authority.inspect();
		// A delayed retransmission of round 1 answers a dead connection; it
		// must not fold, move the receipt, or emit outcomes.
		expect(sync({ round: 1, intents: first })).toEqual({
			result: 'replica-fork',
		});
		expect(authority.inspect()).toEqual(before);
	});

	test('a corrupt digest is refused before any folding', () => {
		const { sync } = openTestAuthority();
		expect(() =>
			sync({
				round: 1,
				intents: [create(rid(1), { count: 1 })],
				digest: 'not-the-digest',
			}),
		).toThrow('Sealed round digest does not match its intents');
	});

	test('a checkpoint ahead of the authority is refused', () => {
		const { sync } = openTestAuthority();
		expect(() => sync({ checkpoint: 99 })).toThrow(
			'Sync checkpoint is ahead of the authority',
		);
	});
});

describe('scalar conflicts follow authority acceptance order (ADR-0131)', () => {
	test('the later accepted absolute value wins regardless of authorship', () => {
		const sqlite = new Database(':memory:');
		const authority = openRowAuthority({
			database: createBunSqliteAdapter(sqlite),
			codec,
		});
		const enrollA = authority.enroll({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'enroll',
		});
		const enrollB = authority.enroll({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'enroll',
		});
		if (enrollA.result !== 'enrolled' || enrollB.result !== 'enrolled') throw new Error('Enrollment failed');
		const createIntent = [create(rid(1), { title: 'base' })];
		authority.sync({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'sync',
			token: { replicaId: enrollA.replicaId, acceptedRound: 0, checkpoint: 0 },
			sealedRound: {
				round: 1,
				requestDigest: rowRoundDigest(createIntent),
				intents: createIntent,
			},
		});
		// B's "older authored" change is accepted after A's newer one.
		const fromA = [
			update(rid(1), { set: { title: 'authored-later' }, unset: [] }),
		];
		const fromB = [
			update(rid(1), { set: { title: 'authored-earlier' }, unset: [] }),
		];
		authority.sync({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'sync',
			token: { replicaId: enrollA.replicaId, acceptedRound: 1, checkpoint: 0 },
			sealedRound: {
				round: 2,
				requestDigest: rowRoundDigest(fromA),
				intents: fromA,
			},
		});
		authority.sync({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'sync',
			token: { replicaId: enrollB.replicaId, acceptedRound: 0, checkpoint: 0 },
			sealedRound: {
				round: 1,
				requestDigest: rowRoundDigest(fromB),
				intents: fromB,
			},
		});
		expect(authority.inspect().rows[0]?.fields).toEqual({
			title: 'authored-earlier',
		});
	});
});

describe('paging (ADR-0133)', () => {
	test('a later scalar write does not tear an earlier composite outcome across pages', () => {
		const { sync } = openTestAuthority();
		sync({
			round: 1,
			intents: [create(rid(1), { title: 'initial' }, docUpdate('d1'))],
		});
		sync({
			round: 2,
			acceptedRound: 1,
			intents: [update(rid(1), { set: { title: 'updated' }, unset: [] })],
		});

		const first = expectPage(sync({ checkpoint: 0, pageLimit: 1 }));
		expect(first).toMatchObject({
			token: { acceptedRound: 2, checkpoint: 1 },
			outcomes: [
				{
					kind: 'row',
					table: 'notes',
					rowId: rid(1),
					fields: { title: 'initial' },
					documentUpdate: docUpdate('d1'),
					sequence: 1,
				},
			],
			hasMore: true,
		});

		expect(expectPage(sync({ checkpoint: 1, pageLimit: 1 }))).toMatchObject({
			token: { acceptedRound: 2, checkpoint: 2 },
			outcomes: [
				{
					kind: 'row',
					table: 'notes',
					rowId: rid(1),
					fields: { title: 'updated' },
					sequence: 2,
				},
			],
			hasMore: false,
		});
	});

	test('one composite outcome never splits across pages', () => {
		const { sync } = openTestAuthority();
		expectPage(
			sync({
				round: 1,
				intents: [
					create(rid(1), { n: 1 }, docUpdate('d1')),
					create(rid(2), { n: 2 }, docUpdate('d2')),
					create(rid(3), { n: 3 }, docUpdate('d3')),
				],
			}),
		);
		const seen: number[] = [];
		let checkpoint = 0;
		for (;;) {
			const page = expectPage(sync({ checkpoint, pageLimit: 1 }));
			for (const outcome of page.outcomes) {
				if (outcome.kind !== 'row') throw new Error('Expected row outcomes');
				// Every page outcome carries BOTH halves of its intent.
				expect(outcome.fields).toBeDefined();
				expect(outcome.documentUpdate).toBeDefined();
				seen.push(outcome.sequence);
			}
			checkpoint = page.token.checkpoint;
			if (!page.hasMore) break;
		}
		expect(seen).toEqual([1, 2, 3]);
	});

	test('every page reports the retention floor', () => {
		const { sync } = openTestAuthority();
		const page = expectPage(sync({}));
		expect(page.retentionFloor).toBe(0);
	});
});

describe('retention floor and compaction (ADR-0133/0136)', () => {
	function seedRounds() {
		const context = openTestAuthority();
		const { sync } = context;
		sync({ round: 1, intents: [create(rid(1), { n: 1 }, docUpdate('d1'))] });
		sync({
			round: 2,
			acceptedRound: 1,
			intents: [update(rid(1), undefined, docUpdate('d2'))],
		});
		sync({
			round: 3,
			acceptedRound: 2,
			intents: [create(rid(2), { n: 2 }), remove(rid(2))],
		});
		// head is now 5: seq 1 create, 2 doc update, 3 create, 4 unused? no:
		// round 3 folds two intents at sequences 3 and 4.
		return context;
	}

	test('compaction folds the covered document tail into one baseline', () => {
		const { authority, sqlite } = seedRounds();
		const floor = authority.compactOutcomesThrough(4);
		expect(floor).toBe(4);
		const inspected = authority.inspect();
		expect(inspected.retentionFloor).toBe(4);
		expect(inspected.deletionOutcomes).toEqual([]);
		expect(inspected.documentUpdates).toEqual([]);
		expect(inspected.documentBaselines).toEqual([
			{ table: 'notes', rowId: rid(1), throughSequence: 2 },
		]);
		expect(
			sqlite
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM row_sync_field_outcomes',
				)
				.get()?.count,
		).toBe(0);
		// Outcome compaction does not remove the live current-row baseline.
		expect(inspected.rows).toEqual([
			{ table: 'notes', rowId: rid(1), fields: { n: 1 }, sequence: 1 },
		]);
	});

	test('a checkpoint below the floor requires baseline acquisition', () => {
		const { authority, sync } = seedRounds();
		authority.compactOutcomesThrough(4);
		const response = sync({ checkpoint: 2 });
		expect(response).toMatchObject({ result: 'baseline-required', retentionFloor: 4 });
		// At or above the floor, incremental pages continue.
		expect(expectPage(sync({ checkpoint: 4 })).result).toBe('page');
	});

	test('maybeCompact keeps the trailing retention window reachable', () => {
		const { authority } = seedRounds();
		expect(authority.maybeCompact({ minimumRetainedSequences: 100 })).toBe(
			undefined,
		);
		expect(authority.maybeCompact({ minimumRetainedSequences: 1 })).toBe(3);
		expect(authority.inspect().retentionFloor).toBe(3);
	});
});

describe('baseline scan (ADR-0136)', () => {
	test('scans complete live rows in stable address order with document composites', () => {
		const { authority, sync } = openTestAuthority();
		sync({
			round: 1,
			intents: [
				create(rid(2), { n: 2 }),
				create(rid(1), { n: 1 }, docUpdate('d1')),
			],
		});
		sync({
			round: 2,
			acceptedRound: 1,
			intents: [update(rid(1), undefined, docUpdate('d2'))],
		});
		authority.compactOutcomesThrough(2);
		sync({
			round: 3,
			acceptedRound: 2,
			intents: [update(rid(1), undefined, docUpdate('d3'))],
		});

		const first = authority.baselineScan({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
			pageLimit: 1,
		});
		if (first.result !== 'page') throw new Error('Expected a scan page');
		expect(first.hasMore).toBeTrue();
		expect(first.head).toBe(4);
		expect(first.retentionFloor).toBe(2);
		expect(first.rows).toEqual([
			{
				table: 'notes',
				rowId: rid(1),
				fields: { n: 1 },
				document: {
					// The floor at 2 covers only d1 (sequence 2); d2 (sequence 3)
					// and d3 (sequence 4) remain in the retained tail.
					baseline: encodeBase64(
						codec.mergedCompactState([encoder.encode(JSON.stringify(['d1']))]),
					),
					updates: [docUpdate('d2'), docUpdate('d3')],
				},
			},
		]);

		const second = authority.baselineScan({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
			after: { table: 'notes', rowId: rid(1) },
		});
		if (second.result !== 'page') throw new Error('Expected a scan page');
		expect(second.hasMore).toBeFalse();
		expect(second.rows).toEqual([
			{ table: 'notes', rowId: rid(2), fields: { n: 2 } },
		]);
	});
});

describe('baseline scan transport collapse (ADR-0136)', () => {
	test('a redundant retained tail collapses through the codec instead of failing the page', () => {
		const { authority, sync } = openTestAuthority();
		// One 200 KiB token repeated across many accepted updates: every merge
		// stays below the canonical document maximum (the union is one token),
		// but the retained base64 tail exceeds the page envelope.
		const token = 't'.repeat(200 * 1024);
		sync({ round: 1, intents: [create(rid(1), { n: 1 }, docUpdate(token))] });
		for (let round = 2; round <= 33; round += 1) {
			sync({
				round,
				acceptedRound: round - 1,
				intents: [update(rid(1), undefined, docUpdate(token))],
			});
		}
		const scan = authority.baselineScan({
			protocolMajor: ROW_SYNC_PROTOCOL_MAJOR,
			kind: 'baselineScan',
		});
		if (scan.result !== 'page') throw new Error('Expected a scan page');
		expect(scan.rows).toHaveLength(1);
		expect(scan.rows[0]?.document?.updates).toEqual([]);
		expect(scan.rows[0]?.document?.baseline).toBe(docUpdate(token));
	});
});

describe('reserved KV row (ADR-0132)', () => {
	const kvUpdate = (
		set: Record<string, unknown>,
		unset: string[] = [],
	): WireRowIntent => ({
		kind: 'update',
		table: '__epicenter_kv',
		rowId: 'workspace',
		fields: { set: set as never, unset },
	});

	test('the reserved row materializes on first write and folds from {}', () => {
		const { authority, sync } = openTestAuthority();
		const page = expectPage(
			sync({ round: 1, intents: [kvUpdate({ 'editor.theme': 'dark' })] }),
		);
		expect(page.outcomes).toEqual([
			{
				kind: 'row',
				table: '__epicenter_kv',
				rowId: 'workspace',
				fields: { 'editor.theme': 'dark' },
				sequence: 1,
			},
		]);
		expect(authority.inspect().rows[0]?.rowId).toBe('workspace');
	});

	test('a later update whose composed image exceeds the aggregate cap no-ops', () => {
		const { authority, sync } = openTestAuthority();
		sync({
			round: 1,
			intents: [
				kvUpdate({
					big: 'x'.repeat(
						ROW_SYNC_ADMISSION_LIMITS.encodedKvAggregateBytes - 1024,
					),
				}),
			],
		});
		expectPage(
			sync({
				round: 2,
				acceptedRound: 1,
				intents: [kvUpdate({ more: 'y'.repeat(4096) })],
			}),
		);
		const fields = authority.inspect().rows[0]?.fields;
		expect(fields && 'more' in fields).toBeFalse();
	});
});
