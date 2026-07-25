/**
 * Data Sync Supervisor Tests
 *
 * Verifies that sync attachment owns a continuous exchange loop rather than a
 * one-shot call.
 *
 * Key behaviors:
 * - A committed local write wakes exchange immediately
 * - Transport failure reports offline and scheduled retry recovers
 * - Credential absence pauses exchange until credentials return
 * - Status transitions are observable
 *
 * Failure ownership: most drains are started by a background wake that
 * discards the promise, so every wake below also asserts that nothing escaped
 * as an unhandled rejection, that an unexpected throw is reported as its own
 * fault rather than as transport trouble, and that a queued wake, a generation
 * change, or disposal cannot strand work.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { defineLens, defineTable } from './definitions.js';
import { createEpicenter } from './epicenter.js';
import type { ExchangeRequest, ExchangeResponse } from './protocol/index.js';
import { openReplica } from './replica/index.js';
import type {
	SyncCredentialProvider,
	SyncSchedule,
} from './sync-supervisor.js';

const notes = defineTable({
	fields: { title: field.string() },
});

function setup() {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplica({ database }));
	const scheduled: Array<{ task: () => void; cancelled: boolean }> = [];
	const schedule: SyncSchedule = (task) => {
		const entry = { task, cancelled: false };
		scheduled.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	const epicenter = createEpicenter({
		replica,
		database,
		scheduleSync: schedule,
		syncIntervalMs: 60_000,
	});
	return { raw, epicenter, scheduled };
}

function successfulResponse(request: ExchangeRequest): ExchangeResponse {
	return {
		...(request.batch === undefined
			? {}
			: {
					receipt: {
						seq: request.batch.seq,
						digest: request.batch.digest,
						appliedThrough: request.after,
					},
				}),
		through: request.after,
		facts: [],
		next: null,
	};
}

function createCredentials(
	initial: string | undefined,
): SyncCredentialProvider & {
	set(value: string | undefined): void;
} {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of listeners) listener();
		},
	};
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for supervisor state');
}

/**
 * Capture unhandled rejections for the duration of one test.
 *
 * Background drains discard their promise, so "the supervisor owns every
 * failure" is only provable by watching the process-level channel a lost
 * rejection would escape through.
 */
function trackUnhandledRejections(): {
	readonly seen: unknown[];
	stop(): void;
} {
	const seen: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		seen.push(reason);
	};
	process.on('unhandledRejection', onUnhandled);
	return {
		seen,
		stop: () => {
			process.off('unhandledRejection', onUnhandled);
		},
	};
}

/** Give any pending rejection time to surface as unhandled. */
async function settle(): Promise<void> {
	await Bun.sleep(5);
	await Bun.sleep(5);
}

/** A credential provider whose `get` can be made to throw mid-flight. */
function createExplodingCredentials(): SyncCredentialProvider & {
	explode(): void;
} {
	const listeners = new Set<() => void>();
	let isExploding = false;
	return {
		get() {
			if (isExploding) throw new Error('credential provider exploded');
			return 'token';
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		explode() {
			isExploding = true;
		},
	};
}

test('local write triggers an exchange without waiting for the interval', async () => {
	const { raw, epicenter } = setup();
	let exchanges = 0;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange(request) {
				exchanges += 1;
				return successfulResponse(request);
			},
		}),
	);
	const initial = exchanges;
	await epicenter
		.bind(
			defineLens({
				namespace: 'so.epicenter.tests',
				tables: { notes },
				values: {},
			}),
		)
		.tables.notes.create({
			title: 'wake',
		});
	await waitFor(() => exchanges > initial);
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(epicenter.syncStatus.state).toBe('idle');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('network failure reports offline and scheduled retry recovers', async () => {
	const { raw, epicenter, scheduled } = setup();
	let isOffline = true;
	const states: string[] = [];
	epicenter.subscribeSyncStatus((status) => states.push(status.state));
	const failed = await epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		exchange(request) {
			if (isOffline) throw new Error('network unavailable');
			return successfulResponse(request);
		},
	});
	expectErr(failed);
	expect(epicenter.syncStatus.state).toBe('offline');
	expect(epicenter.syncStatus.lastError?.message).toContain(
		'network unavailable',
	);
	isOffline = false;
	const retry = scheduled.find((entry) => !entry.cancelled);
	expect(retry).toBeDefined();
	retry?.task();
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(states).toContain('syncing');
	expect(states).toContain('offline');
	expect(states.at(-1)).toBe('idle');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('credential absence pauses and reports authentication-required', async () => {
	const { raw, epicenter } = setup();
	const credentials = createCredentials(undefined);
	let exchanges = 0;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			credentials,
			exchange(request) {
				exchanges += 1;
				return successfulResponse(request);
			},
		}),
	);
	expect(epicenter.syncStatus.state).toBe('authentication-required');
	expect(exchanges).toBe(0);
	credentials.set('token');
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(exchanges).toBe(1);
	credentials.set(undefined);
	expect(epicenter.syncStatus.state).toBe('authentication-required');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('rapid document edits inside the coalesce window become one publication', async () => {
	const { raw, epicenter, scheduled } = setup();
	let publishes = 0;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange: successfulResponse,
			publishDocument: () => {
				publishes += 1;
				return 'accepted';
			},
		}),
	);
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	const notesTable = epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.tests',
			tables: { notes },
			values: {},
		}),
	).tables.notes;
	const row = await notesTable.create({ title: 'coalesce' });
	await waitFor(() => epicenter.syncStatus.state === 'idle');

	const baseline = scheduled.length;
	const document = await notesTable.openDocument(row.id);
	document.transact(() => document.get('content').insert(0, 'a'));
	document.transact(() => document.get('content').insert(1, 'b'));
	document.transact(() => document.get('content').insert(2, 'c'));
	await Bun.sleep(1);

	// Three dirty wakes coalesce into exactly one scheduled document drain.
	const pending = scheduled.slice(baseline).filter((entry) => !entry.cancelled);
	expect(pending).toHaveLength(1);
	expect(publishes).toBe(0);
	pending[0]?.task();
	await waitFor(() => publishes === 1);
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(publishes).toBe(1);

	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('an unexpected dependency throw is reported as a fault, not a transport error', async () => {
	const { raw, epicenter } = setup();
	const rejections = trackUnhandledRejections();
	const credentials = createExplodingCredentials();
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			credentials,
			exchange: successfulResponse,
		}),
	);
	await waitFor(() => epicenter.syncStatus.state === 'idle');

	// The throw happens inside the drain, on a background wake nobody awaits.
	credentials.explode();
	await epicenter
		.bind(
			defineLens({
				namespace: 'so.epicenter.tests',
				tables: { notes },
				values: {},
			}),
		)
		.tables.notes.create({
			title: 'wake',
		});
	await waitFor(() => epicenter.syncStatus.state === 'offline');
	await settle();

	expect(epicenter.syncStatus.lastError?.message).toContain(
		'Sync faulted unexpectedly',
	);
	expect(epicenter.syncStatus.lastError?.message).toContain(
		'credential provider exploded',
	);
	// A bug must not be dressed up as a network failure.
	expect(epicenter.syncStatus.lastError?.message).not.toContain(
		'Replica exchange failed',
	);
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('an outbox-triggered failure is owned, not left as an unhandled rejection', async () => {
	const { raw, epicenter } = setup();
	const rejections = trackUnhandledRejections();
	let isOffline = false;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange(request) {
				if (isOffline) throw new Error('network unavailable');
				return successfulResponse(request);
			},
		}),
	);
	await waitFor(() => epicenter.syncStatus.state === 'idle');

	isOffline = true;
	// A committed local write wakes the drain through `void requestExchange()`.
	await epicenter
		.bind(
			defineLens({
				namespace: 'so.epicenter.tests',
				tables: { notes },
				values: {},
			}),
		)
		.tables.notes.create({
			title: 'wake',
		});
	await waitFor(() => epicenter.syncStatus.state === 'offline');
	await settle();

	expect(epicenter.syncStatus.lastError?.message).toContain(
		'network unavailable',
	);
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('a scheduled wake failure is owned and schedules the next retry', async () => {
	const { raw, epicenter, scheduled } = setup();
	const rejections = trackUnhandledRejections();
	let isOffline = true;
	expectErr(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange(request) {
				if (isOffline) throw new Error('network unavailable');
				return successfulResponse(request);
			},
		}),
	);
	expect(epicenter.syncStatus.state).toBe('offline');

	// Fire the retry wake while it still fails: the background wake owns it.
	const firstRetry = scheduled.find((entry) => !entry.cancelled);
	expect(firstRetry).toBeDefined();
	firstRetry?.task();
	await settle();
	expect(epicenter.syncStatus.state).toBe('offline');
	expect(rejections.seen).toEqual([]);

	// Backoff kept scheduling, so recovery does not depend on a local write.
	isOffline = false;
	const nextRetry = scheduled.filter((entry) => !entry.cancelled).at(-1);
	expect(nextRetry).toBeDefined();
	nextRetry?.task();
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('a document-coalescing wake failure is owned by the supervisor', async () => {
	const { raw, epicenter, scheduled } = setup();
	const rejections = trackUnhandledRejections();
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange: successfulResponse,
			publishDocument() {
				throw new Error('publish carrier unavailable');
			},
		}),
	);
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	const notesTable = epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.tests',
			tables: { notes },
			values: {},
		}),
	).tables.notes;
	const row = await notesTable.create({ title: 'doc' });
	await waitFor(() => epicenter.syncStatus.state === 'idle');

	const baseline = scheduled.length;
	const document = await notesTable.openDocument(row.id);
	document.transact(() => document.get('content').insert(0, 'a'));
	await Bun.sleep(1);
	const wake = scheduled.slice(baseline).find((entry) => !entry.cancelled);
	expect(wake).toBeDefined();
	// The coalesced wake runs through `void startDrain()`; its failure has an owner.
	wake?.task();
	await waitFor(() => epicenter.syncStatus.state === 'offline');
	await settle();

	expect(epicenter.syncStatus.lastError?.message).toContain(
		'publish carrier unavailable',
	);
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

/** A latch the test opens to let one in-flight exchange finish. */
function createGate(): { promise: Promise<void>; open(): void } {
	let open: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		open = () => resolve();
	});
	return { promise, open: () => open() };
}

test('work queued during an active drain runs instead of being lost', async () => {
	const { raw, epicenter } = setup();
	const rejections = trackUnhandledRejections();
	const gate = createGate();
	let exchanges = 0;
	// Do not await: the first exchange stays in flight while work is queued.
	const attached = epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		async exchange(request) {
			exchanges += 1;
			if (exchanges === 1) await gate.promise;
			return successfulResponse(request);
		},
	});
	await waitFor(() => exchanges === 1);

	// A local write wakes the drain while the first cycle is still running.
	await epicenter
		.bind(
			defineLens({
				namespace: 'so.epicenter.tests',
				tables: { notes },
				values: {},
			}),
		)
		.tables.notes.create({
			title: 'queued',
		});
	gate.open();
	expectOk(await attached);

	await waitFor(() => exchanges >= 2);
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('a credential change during an active drain continues at the new generation', async () => {
	const { raw, epicenter } = setup();
	const rejections = trackUnhandledRejections();
	const credentials = createCredentials('token');
	const gate = createGate();
	let exchanges = 0;
	const attached = epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		credentials,
		async exchange(request) {
			exchanges += 1;
			if (exchanges === 1) await gate.promise;
			return successfulResponse(request);
		},
	});
	await waitFor(() => exchanges === 1);

	// Bumps the generation mid-flight, so the wake chains off the running drain.
	credentials.set('rotated');
	gate.open();
	expectOk(await attached);

	// The chained continuation must run; a dropped one would strand the rotation.
	await waitFor(() => exchanges >= 2);
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('disposal during an active drain stops later work without an unhandled rejection', async () => {
	const { raw, epicenter } = setup();
	const rejections = trackUnhandledRejections();
	const gate = createGate();
	let exchanges = 0;
	const attached = epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		async exchange(request) {
			exchanges += 1;
			if (exchanges === 1) await gate.promise;
			return successfulResponse(request);
		},
	});
	await waitFor(() => exchanges === 1);

	const disposal = epicenter[Symbol.asyncDispose]();
	gate.open();
	await attached;
	await disposal;
	await settle();

	// The in-flight cycle finished; nothing new was started behind disposal.
	expect(exchanges).toBe(1);
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	raw.close();
});

test('a foreground caller receives the fault as a Result rather than a rejection', async () => {
	const { raw, epicenter } = setup();
	const rejections = trackUnhandledRejections();
	// `attach` probes credentials once, then the drain probes them again.
	let gets = 0;
	const credentials: SyncCredentialProvider = {
		get() {
			gets += 1;
			if (gets > 1) throw new Error('credential provider exploded');
			return 'token';
		},
		subscribe: () => () => {},
	};

	const attached = await epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		credentials,
		exchange: successfulResponse,
	});

	const failure = expectErr(attached);
	expect(failure.name).toBe('SyncFaulted');
	expect(epicenter.syncStatus.state).toBe('offline');
	await settle();
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('a background wake failure cannot surface as the local write rejecting', async () => {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplica({ database }));
	// A scheduler whose canceller throws: `requestExchange` cancels the pending
	// wake before starting, so the outbox wake throws synchronously.
	const schedule: SyncSchedule = (task) => {
		void task;
		return () => {
			throw new Error('scheduler canceller exploded');
		};
	};
	const epicenter = createEpicenter({
		replica,
		database,
		scheduleSync: schedule,
		syncIntervalMs: 60_000,
	});
	await epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		exchange: successfulResponse,
	});

	// The write must succeed on its own terms; sync trouble is not its failure.
	const row = await epicenter
		.bind(
			defineLens({
				namespace: 'so.epicenter.tests',
				tables: { notes },
				values: {},
			}),
		)
		.tables.notes.create({ title: 'write' });
	expect(row.title).toBe('write');

	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('a throwing scheduler does not turn a successful cycle into a reported failure', async () => {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplica({ database }));
	const rejections = trackUnhandledRejections();
	// The tail of a successful cycle schedules the periodic safety wake.
	const schedule: SyncSchedule = () => {
		throw new Error('scheduler exploded');
	};
	const epicenter = createEpicenter({
		replica,
		database,
		scheduleSync: schedule,
		syncIntervalMs: 60_000,
	});

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange: successfulResponse,
		}),
	);
	await settle();

	// A cycle that actually synchronized must not be reported as offline.
	expect(epicenter.syncStatus.state).toBe('idle');
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('disposal during a failing drain leaves no retry scheduled', async () => {
	const { raw, epicenter, scheduled } = setup();
	const rejections = trackUnhandledRejections();
	const gate = createGate();
	let exchanges = 0;
	const attached = epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		async exchange(request) {
			exchanges += 1;
			if (exchanges === 1) {
				await gate.promise;
				// Fails only after disposal has already begun.
				throw new Error('carrier exploded');
			}
			return successfulResponse(request);
		},
	});
	await waitFor(() => exchanges === 1);

	const disposal = epicenter[Symbol.asyncDispose]();
	const liveBeforeFault = scheduled.filter((entry) => !entry.cancelled).length;
	gate.open();
	await attached;
	await disposal;
	await settle();

	// A disposed supervisor must not end holding a live retry timer.
	const liveAfterFault = scheduled.filter((entry) => !entry.cancelled).length;
	expect(liveAfterFault).toBe(liveBeforeFault);
	expect(rejections.seen).toEqual([]);
	rejections.stop();
	raw.close();
});
