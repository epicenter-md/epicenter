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
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { defineTable } from './definitions.js';
import { createEpicenter } from './epicenter.js';
import type { ExchangeRequest, ExchangeResponse } from './protocol/index.js';
import { openReplica } from './replica/index.js';
import type {
	SyncCredentialProvider,
	SyncSchedule,
} from './sync-supervisor.js';

const notes = defineTable({
	key: 'so.epicenter.tests.supervisor-notes',
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
		records: [],
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
	await epicenter.bind({ tables: { notes }, values: {} }).tables.notes.create({
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
	const notesTable = epicenter.bind({ tables: { notes }, values: {} }).tables
		.notes;
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
