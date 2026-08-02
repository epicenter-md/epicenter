/**
 * The reconciler's drain phase: the only place in Local Mail that writes to
 * Gmail. These pin the delivery contract:
 *
 * - One message's opinions become ONE `messages.modify`, with trash routed to
 *   Gmail's own endpoint at delivery and never smuggled into a label set.
 * - Retirement requires the sequence that was delivered, so an act made while a
 *   delivery is in flight survives it.
 * - A refused request is retried one assertion at a time before anything is
 *   resolved, so one impossible label cannot discard the archive that shared its
 *   call; a systemic failure stops delivery and keeps every assertion, with
 *   nothing written down about the failure itself.
 * - An act made mid-delivery wins, because retirement matches the sequence that
 *   was actually proved.
 * - Read-only skips delivery entirely.
 *
 * The pull phase is `sync.ts`, tested there; the fake client below returns an
 * empty history so a pass ends quickly.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMessageLabels } from './assert.ts';
import type { AppConfig } from './config.ts';
import { type MailDb, openMailDb } from './db.ts';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import { type IntentDb, openIntentDb } from './intent.ts';
import { acquireReconcileLock } from './lock.ts';
import { type ReconcileDeps, reconcileAccount } from './reconcile.ts';
import type { GmailLabel, GmailMessage, HistoryPage } from './schema.ts';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

function message(id: string, labelIds: string[]): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds,
		snippet: `snippet ${id}`,
		internalDate: '1700000000000',
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

function config(dataDir: string): AppConfig {
	return {
		dataDir,
		apiBase: 'http://localhost:0',
		authorizeUrl: 'http://localhost:0/auth',
		tokenUrl: 'http://localhost:0/token',
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath: join(dataDir, 'credentials.json'),
		account: null,
		readOnly: false,
	};
}

type WriteResult =
	| { data: GmailMessage }
	| {
			error: NonNullable<
				Awaited<ReturnType<GmailClient['modifyMessage']>>['error']
			>;
	  };

type FakeGmail = GmailClient & {
	modifyCalls: {
		id: string;
		addLabelIds: string[];
		removeLabelIds: string[];
	}[];
	trashCalls: string[];
	untrashCalls: string[];
	/** The scripted per-id results, exposed so a test can change Gmail's answer
	 * between two passes. */
	results: Map<string, WriteResult>;
};

const MIRRORED_LABELS: GmailLabel[] = [
	{ id: 'INBOX', name: 'INBOX', type: 'system' },
	{ id: 'UNREAD', name: 'UNREAD', type: 'system' },
	{ id: 'STARRED', name: 'STARRED', type: 'system' },
	{ id: 'TRASH', name: 'TRASH', type: 'system' },
];

/**
 * A Gmail client whose write endpoints are scripted per message id and whose
 * read endpoints report an unchanged mailbox, so the pull phase is a no-op.
 *
 * `onWrite` fires before the scripted result is returned, which is how the
 * racing-act tests slip a real triage act into the middle of a delivery.
 * `onModify` answers by request body rather than by id, which is how the
 * splitting test makes one label acceptable and another not.
 */
function fakeGmail(
	results: Map<string, WriteResult>,
	hooks: {
		onWrite?: (id: string) => void;
		onModify?: (body: {
			addLabelIds: string[];
			removeLabelIds: string[];
		}) => WriteResult | null;
	} = {},
): FakeGmail {
	const modifyCalls: FakeGmail['modifyCalls'] = [];
	const trashCalls: string[] = [];
	const untrashCalls: string[] = [];
	const answer = (result: WriteResult) =>
		'error' in result
			? { data: null, error: result.error }
			: { data: result.data, error: null };
	const lookup = (id: string) => {
		hooks.onWrite?.(id);
		const result = results.get(id);
		if (!result) return GmailApiError.Http({ status: 404, body: 'not found' });
		return answer(result);
	};
	return {
		modifyCalls,
		trashCalls,
		untrashCalls,
		results,
		async modifyMessage(id, body) {
			modifyCalls.push({ id, ...body });
			const scripted = hooks.onModify?.(body);
			if (scripted) {
				hooks.onWrite?.(id);
				return answer(scripted);
			}
			return lookup(id);
		},
		async trashMessage(id) {
			trashCalls.push(id);
			return lookup(id);
		},
		async untrashMessage(id) {
			untrashCalls.push(id);
			return lookup(id);
		},
		async listMessageIds() {
			return { data: { ids: [] }, error: null };
		},
		async getMessage() {
			return GmailApiError.Http({ status: 404, body: 'not found' });
		},
		async listHistory(): Promise<{ data: HistoryPage; error: null }> {
			return { data: { historyId: '1' }, error: null };
		},
		async listLabels(): Promise<{ data: GmailLabel[]; error: null }> {
			// The pull phase replaces the mirrored label set with whatever this
			// returns, so hand back the seeded one rather than emptying the table
			// underneath a later act.
			return { data: MIRRORED_LABELS, error: null };
		},
		async getProfile() {
			return { data: { historyId: '1' }, error: null };
		},
	};
}

function setup(
	client: GmailClient,
	messages: GmailMessage[] = [message('m1', ['INBOX', 'UNREAD'])],
): { deps: ReconcileDeps; db: MailDb; intent: IntentDb; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-reconcile-'));
	const db = openMailDb({ dataDir: dir, accountEmail: 'you@example.com' });
	const intent = openIntentDb({
		dataDir: dir,
		accountEmail: 'you@example.com',
	});
	const syncedAt = new Date(NOW).toISOString();
	db.ingestFullPullPage(messages, syncedAt);
	db.ingestLabels(MIRRORED_LABELS, syncedAt);
	// A cursor plus a recent sync keeps the pull phase INCREMENTAL, so these
	// tests exercise delivery rather than a full backfill.
	db.finishFullPull('1', syncedAt);
	return {
		deps: {
			db,
			intent,
			client,
			config: config(dir),
			now: () => NOW,
			accountEmail: 'you@example.com',
		},
		db,
		intent,
		cleanup: () => {
			intent.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * One pass, as a real owner runs one: take the account's reconcile lock, deliver
 * under it, release. A pass cannot be called without the capability, so the
 * tests below reach the write path the only way production does. Ownership
 * itself is tested in its own block; here it is setup.
 */
async function pass(deps: ReconcileDeps, readOnly = false) {
	const lock = acquireReconcileLock({
		dataDir: deps.config.dataDir,
		accountEmail: deps.accountEmail,
	});
	if (!lock) throw new Error('the test could not become the reconcile owner');
	try {
		return await reconcileAccount(deps, { forceFull: false, readOnly, lock });
	} finally {
		lock.release();
	}
}

/** Gmail's facts for one message, straight out of the mirror column, with no
 * intent overlay: what the reconciler folded, not what a reader would see. */
function mirroredLabels(db: MailDb, id: string): string[] {
	const row = db.raw
		.query<{ label_ids: string | null }, [string]>(
			`SELECT label_ids FROM messages WHERE id = ?`,
		)
		.get(id);
	return JSON.parse(row?.label_ids ?? '[]') as string[];
}

describe('drain', () => {
	test('one message with several opinions becomes one modify call', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['STARRED']) }]]),
		);
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'UNREAD', want: false },
					{ messageId: 'm1', labelId: 'STARRED', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(client.modifyCalls).toEqual([
				{
					id: 'm1',
					addLabelIds: ['STARRED'],
					removeLabelIds: ['INBOX', 'UNREAD'],
				},
			]);
			expect(delivery).toMatchObject({
				pending: 3,
				delivered: 3,
				retained: 0,
				failure: null,
			});
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("Gmail's response updates the mirror before the assertion is retired", async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
		);
		const { deps, db, cleanup } = setup(client);
		try {
			deps.intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				new Date(NOW).toISOString(),
			);
			await pass(deps);
			// The overlay is gone and the fact took its place, so the row never
			// flickers back into the inbox between the two writes.
			expect(mirroredLabels(db, 'm1')).toEqual(['UNREAD']);
			expect(
				db.listMessages({ labelId: 'INBOX', limit: 10, offset: 0 }),
			).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a TRASH assertion routes to messages.trash and stays out of the label set', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['TRASH']) }]]),
		);
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'UNREAD', want: false },
					{ messageId: 'm1', labelId: 'TRASH', want: true },
				],
				new Date(NOW).toISOString(),
			);

			await pass(deps);

			expect(client.trashCalls).toEqual(['m1']);
			expect(client.untrashCalls).toEqual([]);
			// Labels are delivered first, and TRASH never appears in either set.
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['UNREAD'] },
			]);
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a TRASH assertion of want=false routes to messages.untrash', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['INBOX']) }]]),
		);
		const { deps, intent, cleanup } = setup(client, [message('m1', ['TRASH'])]);
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'TRASH', want: false }],
				new Date(NOW).toISOString(),
			);
			await pass(deps);
			expect(client.untrashCalls).toEqual(['m1']);
			expect(client.modifyCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('restoring from trash happens BEFORE the label changes it enables', async () => {
		// The case that made this ordering non-negotiable. A message sits in Gmail
		// Trash, carrying none of the labels a modify would touch, and the user
		// asks for both "restore" and "archive". Delivered labels-first, the modify
		// is a no-op against a trashed message and the untrash then puts INBOX
		// back: both assertions retire and the archive is silently lost.
		const order: string[] = [];
		const client = fakeGmail(new Map(), {
			onWrite: () => undefined,
			onModify: () => {
				order.push('modify');
				return { data: message('m1', ['UNREAD']) };
			},
		});
		const untrashed = client.untrashMessage.bind(client);
		client.untrashMessage = async (id: string) => {
			order.push('untrash');
			return untrashed(id);
		};
		const { deps, intent, db, cleanup } = setup(client, [
			message('m1', ['TRASH']),
		]);
		client.results.set('m1', { data: message('m1', ['INBOX', 'UNREAD']) });
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'TRASH', want: false },
					{ messageId: 'm1', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(order).toEqual(['untrash', 'modify']);
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
			]);
			expect(delivery).toMatchObject({ pending: 2, delivered: 2, retained: 0 });
			// Both wishes held: out of Trash, and out of the inbox.
			expect(mirroredLabels(db, 'm1')).toEqual(['UNREAD']);
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('moving to trash happens AFTER the label changes it would swallow', async () => {
		const order: string[] = [];
		const client = fakeGmail(new Map(), {
			onModify: () => {
				order.push('modify');
				return { data: message('m1', ['STARRED', 'UNREAD']) };
			},
		});
		const trashed = client.trashMessage.bind(client);
		client.trashMessage = async (id: string) => {
			order.push('trash');
			return trashed(id);
		};
		const { deps, intent, cleanup } = setup(client);
		client.results.set('m1', { data: message('m1', ['TRASH']) });
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'TRASH', want: true },
					{ messageId: 'm1', labelId: 'STARRED', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			// The star is applied while the message can still carry it, then it goes
			// to Trash. Reversed, the star would land on a trashed message.
			expect(order).toEqual(['modify', 'trash']);
			expect(delivery).toMatchObject({ pending: 2, delivered: 2, retained: 0 });
		} finally {
			cleanup();
		}
	});

	test('a re-assert during the untrash keeps the newer wish and still delivers the labels', async () => {
		let intent: IntentDb | undefined;
		let reasserted = false;
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['INBOX']) }]]),
			{
				onWrite: () => {
					// The user changes their mind about trash while the untrash is on the
					// wire; the archive they also asked for is untouched by that.
					if (reasserted) return;
					reasserted = true;
					intent?.assert(
						[{ messageId: 'm1', labelId: 'TRASH', want: true }],
						new Date(NOW).toISOString(),
					);
				},
			},
		);
		const created = setup(client, [message('m1', ['TRASH'])]);
		intent = created.intent;
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'TRASH', want: false },
					{ messageId: 'm1', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(created.deps);

			expect(client.untrashCalls).toEqual(['m1']);
			// The untrash proved the old sequence and retires nothing; the archive is
			// unrelated and lands.
			expect(delivery).toMatchObject({ pending: 2, delivered: 1, retained: 1 });
			expect(intent.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'TRASH', want: true },
			]);
		} finally {
			created.cleanup();
		}
	});

	test("a group past Gmail's per-request label cap still lands, one at a time", async () => {
		// The act path caps ONE act at 100 labels per direction; two acts can still
		// accumulate past it for the same message. Nothing pre-empts that: Gmail
		// refuses the oversized request and the split retry delivers every
		// assertion individually.
		const client = fakeGmail(new Map(), {
			onModify: (body) =>
				body.addLabelIds.length > 100
					? {
							error: GmailApiError.Http({
								status: 400,
								body: 'Too many labels',
							}).error,
						}
					: { data: message('m1', ['INBOX']) },
		});
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert(
				Array.from({ length: 101 }, (_, i) => ({
					messageId: 'm1',
					labelId: `Label_${i}`,
					want: true,
				})),
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			// One refused group, then 101 single-assertion deliveries.
			expect(client.modifyCalls).toHaveLength(102);
			expect(delivery).toMatchObject({
				pending: 101,
				delivered: 101,
				discarded: [],
				retained: 0,
			});
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('archive then undo, racing an in-flight drain, keeps the undo', async () => {
		// The whole point of sequencing, driven through the public act path rather
		// than the store: the user archives, the drain picks it up, and the undo
		// lands while that delivery is on the wire.
		let undo: (() => void) | null = null;
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
			{ onWrite: () => undo?.() },
		);
		const created = setup(client);
		const { deps, intent, db, cleanup } = created;
		try {
			const archive = () =>
				assertMessageLabels({
					deps,
					input: { ids: ['m1'], addLabels: [], removeLabels: ['INBOX'] },
					readOnly: false,
				});
			const unarchive = () =>
				assertMessageLabels({
					deps,
					input: { ids: ['m1'], addLabels: ['INBOX'], removeLabels: [] },
					readOnly: false,
				});

			expect(archive().error).toBeNull();
			undo = () => {
				undo = null;
				expect(unarchive().error).toBeNull();
			};

			const first = await pass(deps);

			// Gmail was told to archive, and answered. But the undo carries a newer
			// sequence, so that answer proves nothing about it: nothing is retired,
			// and the mailbox the user sees is back in the inbox on the strength of
			// the still-pending assertion.
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
			]);
			expect(first.delivery).toMatchObject({
				pending: 1,
				delivered: 0,
				retained: 1,
			});
			expect(mirroredLabels(db, 'm1')).toEqual(['UNREAD']);
			expect(
				db
					.listMessages({ labelId: 'INBOX', limit: 10, offset: 0 })
					.map((r) => r.id),
			).toEqual(['m1']);

			// The next pass delivers the undo. That second call is the redundant
			// modify this design accepts: one wasted request, and no lost choice.
			client.results.set('m1', { data: message('m1', ['INBOX', 'UNREAD']) });
			const second = await pass(deps);

			expect(client.modifyCalls).toHaveLength(2);
			expect(client.modifyCalls[1]).toEqual({
				id: 'm1',
				addLabelIds: ['INBOX'],
				removeLabelIds: [],
			});
			expect(second.delivery).toMatchObject({ delivered: 1, retained: 0 });
			expect(intent.pending()).toEqual([]);
			expect(mirroredLabels(db, 'm1')).toEqual(['INBOX', 'UNREAD']);
		} finally {
			cleanup();
		}
	});

	test('a rejected group is retried one assertion at a time', async () => {
		// Gmail refuses the request because of ONE label in it. Retiring the whole
		// group on that basis would throw away the archive the user also asked for,
		// so the group is split and only the individually rejected pair resolves.
		const client = fakeGmail(new Map(), {
			onModify: (body) =>
				body.addLabelIds.includes('Label_gone')
					? {
							error: GmailApiError.Http({
								status: 400,
								body: 'Invalid label: Label_gone',
							}).error,
						}
					: { data: message('m1', ['UNREAD']) },
		});
		const { deps, intent, db, cleanup } = setup(client);
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'Label_gone', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			// One grouped attempt, then one attempt per assertion.
			expect(client.modifyCalls).toEqual([
				{
					id: 'm1',
					addLabelIds: ['Label_gone'],
					removeLabelIds: ['INBOX'],
				},
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
				{ id: 'm1', addLabelIds: ['Label_gone'], removeLabelIds: [] },
			]);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 1,
				retained: 0,
				failure: null,
			});
			// The refusal is reported for this pass and nowhere else: the message,
			// the label, the presence that was wanted, and Gmail's own words.
			expect(delivery.discarded).toEqual([
				{
					messageId: 'm1',
					labelId: 'Label_gone',
					want: true,
					status: 400,
					reason: expect.stringContaining('Invalid label: Label_gone'),
				},
			]);
			expect(intent.pending()).toEqual([]);
			// The archive really landed; only the impossible label was dropped.
			expect(mirroredLabels(db, 'm1')).toEqual(['UNREAD']);
		} finally {
			cleanup();
		}
	});

	test('a systemic failure during a split retry stops the pass and keeps everything', async () => {
		let attempts = 0;
		const client = fakeGmail(new Map(), {
			onModify: () => {
				attempts += 1;
				// The group is refused, and the first split retry hits a throttle.
				return attempts === 1
					? {
							error: GmailApiError.Http({ status: 400, body: 'bad request' })
								.error,
						}
					: { error: GmailApiError.Throttled({ retries: 5 }).error };
			},
		});
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'STARRED', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(delivery.failure?.name).toBe('Throttled');
			expect(delivery).toMatchObject({
				delivered: 0,
				discarded: [],
				retained: 2,
			});
			expect(intent.pending()).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	test('a per-target refusal resolves that assertion and delivery continues', async () => {
		const client = fakeGmail(
			new Map<string, WriteResult>([
				[
					'm1',
					{ error: GmailApiError.Http({ status: 404, body: 'gone' }).error },
				],
				['m2', { data: message('m2', []) }],
			]),
		);
		const { deps, intent, cleanup } = setup(client, [
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
		]);
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm2', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1', 'm2']);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 1,
				retained: 0,
				failure: null,
			});
			// The refusal is reported for this pass and nowhere else: the message,
			// the label, the presence that was wanted, and Gmail's own words.
			expect(delivery.discarded).toEqual([
				{
					messageId: 'm1',
					labelId: 'INBOX',
					want: false,
					status: 404,
					reason: expect.stringContaining('Gmail API returned 404'),
				},
			]);
			// Nothing about the refusal is written down: the store holds wishes, not
			// a dead-letter queue, and the report above is the whole record of it.
			expect(intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a systemic failure stops delivery and keeps every undelivered assertion', async () => {
		const client = fakeGmail(
			new Map<string, WriteResult>([
				['m1', { error: GmailApiError.Throttled({ retries: 5 }).error }],
				['m2', { data: message('m2', []) }],
			]),
		);
		const { deps, intent, cleanup } = setup(client, [
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
		]);
		try {
			intent.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm2', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery, pull } = await pass(deps);

			// m2 was never attempted: the connection, not the target, is the problem.
			expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1']);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 0,
				discarded: [],
				retained: 2,
			});
			expect(delivery.failure?.name).toBe('Throttled');
			expect(intent.pending()).toHaveLength(2);
			// The pull still runs: a failure to write is not a reason to stop reading.
			expect(pull.failure).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('read-only mode delivers nothing and keeps every assertion', async () => {
		const client = fakeGmail(new Map([['m1', { data: message('m1', []) }]]));
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				new Date(NOW).toISOString(),
			);

			const { delivery, pull } = await pass(deps, true);

			expect(client.modifyCalls).toEqual([]);
			expect(client.trashCalls).toEqual([]);
			expect(delivery).toMatchObject({
				pending: 1,
				delivered: 0,
				retained: 1,
				failure: null,
			});
			expect(intent.pending()).toHaveLength(1);
			// Reads keep working in read-only mode, so the pull still happens.
			expect(pull.failure).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('a pass with nothing pending calls no write endpoint at all', async () => {
		const client = fakeGmail(new Map());
		const { deps, cleanup } = setup(client);
		try {
			const { delivery } = await pass(deps);
			expect(delivery).toEqual({
				pending: 0,
				delivered: 0,
				discarded: [],
				retained: 0,
				failure: null,
			});
			expect(client.modifyCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("folding Gmail's answer", () => {
	test('an omitted labelIds is folded as an empty set, not skipped', async () => {
		// Gmail's JSON encoding omits empty repeated fields, so removing a message's
		// last label comes back as a Message with no `labelIds` key at all. Treating
		// that as "no answer" and skipping the fold would retire the assertion while
		// the mirror still claimed the old label, and the next pull is exactly what
		// fails when anything is wrong, so the stale fact would resurface.
		const client = fakeGmail(
			new Map([['m1', { data: { id: 'm1', threadId: 't-m1' } }]]),
		);
		const { deps, db, intent, cleanup } = setup(client, [
			message('m1', ['INBOX']),
		]);
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				new Date(NOW).toISOString(),
			);

			const outcome = await pass(deps);
			expect(outcome.delivery.delivered).toBe(1);
			expect(intent.pending()).toEqual([]);

			// Gmail's answer, folded: the message carries nothing now.
			expect(mirroredLabels(db, 'm1')).toEqual([]);
			// And with the assertion retired there is no overlay left to hide the row,
			// so this is the whole of what keeps it out of the inbox.
			expect(
				db.listMessages({ labelId: 'INBOX', limit: 10, offset: 0 }),
			).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe('ownership', () => {
	test('a second reconciler cannot run while the first holds the account', async () => {
		// The one-writer rule is the capability, not a convention. `reconcileAccount`
		// takes a `ReconcileLock` that only `acquireReconcileLock` can mint, so a
		// would-be second reconciler has nothing to pass it: the refusal happens at
		// acquisition, before any Gmail call is even reachable.
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
		);
		const { deps, intent, cleanup } = setup(client);
		try {
			intent.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				new Date(NOW).toISOString(),
			);

			const first = acquireReconcileLock({
				dataDir: deps.config.dataDir,
				accountEmail: deps.accountEmail,
			});
			expect(first).not.toBeNull();

			// The second owner is refused, so it never obtains the capability a pass
			// requires. There is no other way in: `reconcileAccount` has no overload
			// that skips the lock.
			const second = acquireReconcileLock({
				dataDir: deps.config.dataDir,
				accountEmail: deps.accountEmail,
			});
			expect(second).toBeNull();

			// Nothing reached Gmail on the refused path, and the change is still owed.
			expect(client.modifyCalls).toEqual([]);
			expect(intent.pending()).toHaveLength(1);

			// The holder can still run, and the release hands ownership on.
			const owned = await reconcileAccount(deps, {
				forceFull: false,
				readOnly: false,
				// biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
				lock: first!,
			});
			expect(owned.delivery.delivered).toBe(1);
			first?.release();

			const third = acquireReconcileLock({
				dataDir: deps.config.dataDir,
				accountEmail: deps.accountEmail,
			});
			expect(third).not.toBeNull();
			third?.release();
		} finally {
			cleanup();
		}
	});

	test("one account's lock cannot authorize a pass over another's mirror", async () => {
		// The desktop host holds one lock per connected account, so "has a lock" is
		// not the same question as "has THIS account's lock". Crossing them would
		// write to a mailbox nobody claimed, which is a programming error rather
		// than a runtime condition, so the pass refuses loudly.
		const client = fakeGmail(new Map());
		const { deps, cleanup } = setup(client);
		try {
			const other = acquireReconcileLock({
				dataDir: deps.config.dataDir,
				accountEmail: 'someone-else@example.com',
			});
			expect(other).not.toBeNull();
			expect(
				reconcileAccount(deps, {
					forceFull: false,
					readOnly: false,
					// biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
					lock: other!,
				}),
			).rejects.toThrow('someone-else@example.com');
			expect(client.modifyCalls).toEqual([]);
			other?.release();
		} finally {
			cleanup();
		}
	});
});

describe('across a restart', () => {
	test('an act made offline survives the process and lands on the next pass', async () => {
		// The product headline, end to end: archive on a plane, quit, reopen on the
		// ground, and the archive reaches Gmail. Everything else in this file tests
		// one seam; this tests that the seams hold across the only event the design
		// exists to survive, which is the process going away between the act and
		// the delivery.
		const dir = mkdtempSync(join(tmpdir(), 'local-mail-restart-'));
		const account = { dataDir: dir, accountEmail: 'you@example.com' };
		const syncedAt = new Date(NOW).toISOString();

		// Session one: offline. Every Gmail call fails with a network error, which
		// is systemic, so nothing may be retired and nothing may be written down
		// about the failure.
		const offline = fakeGmail(new Map());
		offline.modifyMessage = async () =>
			GmailApiError.Network({ cause: new Error('offline') });
		const firstDb = openMailDb(account);
		const firstIntent = openIntentDb(account);
		firstDb.ingestFullPullPage([message('m1', ['INBOX', 'UNREAD'])], syncedAt);
		firstDb.ingestLabels(MIRRORED_LABELS, syncedAt);
		firstDb.finishFullPull('1', syncedAt);
		const firstDeps: ReconcileDeps = {
			db: firstDb,
			intent: firstIntent,
			client: offline,
			config: config(dir),
			now: () => NOW,
			accountEmail: account.accountEmail,
		};

		expect(
			assertMessageLabels({
				deps: firstDeps,
				input: { ids: ['m1'], addLabels: [], removeLabels: ['INBOX'] },
				readOnly: false,
			}).error,
		).toBeNull();
		// The act is already true for every reader, before Gmail has heard.
		expect(
			firstDb.listMessages({ labelId: 'INBOX', limit: 10, offset: 0 }),
		).toEqual([]);

		const offlinePass = await pass(firstDeps);
		expect(offlinePass.delivery.delivered).toBe(0);
		expect(offlinePass.delivery.retained).toBe(1);
		expect(offlinePass.delivery.failure).not.toBeNull();
		expect(offlinePass.delivery.discarded).toEqual([]);

		// The process goes away with the change undelivered.
		firstIntent.close();
		firstDb.close();

		// Session two: a fresh open of both files, as a new process would do, and
		// Gmail is reachable again.
		const online = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
		);
		const secondDb = openMailDb(account);
		const secondIntent = openIntentDb(account);
		const secondDeps: ReconcileDeps = {
			db: secondDb,
			intent: secondIntent,
			client: online,
			config: config(dir),
			now: () => NOW,
			accountEmail: account.accountEmail,
		};

		// The change was still owed when the new process opened the store.
		expect(secondIntent.summary().assertions).toBe(1);

		const landed = await pass(secondDeps);
		expect(landed.delivery.delivered).toBe(1);
		expect(landed.delivery.retained).toBe(0);
		expect(landed.delivery.failure).toBeNull();
		expect(online.modifyCalls).toEqual([
			{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
		]);
		// Gmail's own answer is now the mirror's fact, and nothing is overlaid on
		// it any more, so the reader's answer is unchanged by the delivery.
		expect(mirroredLabels(secondDb, 'm1')).toEqual(['UNREAD']);
		expect(
			secondDb.listMessages({ labelId: 'INBOX', limit: 10, offset: 0 }),
		).toEqual([]);

		secondIntent.close();
		secondDb.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
