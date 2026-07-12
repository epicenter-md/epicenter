import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { field } from '@epicenter/field';
import {
	createRecordAuthority,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { openStandaloneWorkspace, openWorkspaceReplica } from './bun.js';
import { defineTable, defineWorkspace } from './definition.js';

test('Bun standalone workspace persists typed rows across service lifecycles', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sqlite-'));
	const path = join(directory, 'workspace.db');
	const definition = defineWorkspace({
		id: 'bun-local-test',
		name: 'Bun local test',
		epoch: 'bun-local-v1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const errors: unknown[] = [];

	try {
		const first = await openStandaloneWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError: (error) => errors.push(error),
		});
		await first.tables.notes.put({ id: 'one', title: 'Persisted' });
		await expect(
			openStandaloneWorkspace(definition, {
				storage: { kind: 'bun', path },
				onObserverError: (error) => errors.push(error),
			}),
		).rejects.toThrow('already has an owner');
		await first[Symbol.asyncDispose]();

		const mismatched = defineWorkspace({
			id: 'bun-local-test',
			name: 'Bun local test',
			epoch: 'bun-local-v1',
			tables: {
				notes: defineTable({
					id: field.string(),
					title: field.string(),
					body: field.string(),
				}),
			},
		});
		await expect(
			openStandaloneWorkspace(mismatched, {
				storage: { kind: 'bun', path },
				onObserverError: (error) => errors.push(error),
			}),
		).rejects.toThrow('schema identity does not match');

		const reopened = await openStandaloneWorkspace(definition, {
			storage: { kind: 'bun', path },
			onObserverError: (error) => errors.push(error),
		});
		expect(await reopened.tables.notes.get('one')).toEqual({
			id: 'one',
			title: 'Persisted',
		});
		await reopened[Symbol.asyncDispose]();
		expect(errors).toEqual([]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Bun workspace replicas synchronize automatically through one authority', async () => {
	const definition = defineWorkspace({
		id: 'bun-replica-test',
		name: 'Bun replica test',
		epoch: 'bun-replica-v1',
		tables: {
			notes: defineTable({ id: field.string(), title: field.string() }),
		},
	});
	const authorityDatabase = new Database(':memory:');
	const databaseIncarnationId = 'bun-replica-incarnation';
	const envelope = {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		schemaIdentity: definition.schemaIdentity,
		databaseIncarnationId,
	};
	const authority = createRecordAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		envelope,
		sha256: async (value) => createHash('sha256').update(value).digest('hex'),
	});
	const sync = {
		bindWorkspace() {},
		async openDatabase() {
			return { databaseIncarnationId };
		},
		async push(request: Parameters<typeof authority.push>[0]) {
			return authority.push(request);
		},
		async pull(request: Parameters<typeof authority.pull>[0]) {
			return authority.pull(request);
		},
		async snapshotChunk(
			request: Parameters<typeof authority.snapshotChunk>[0],
		) {
			return authority.snapshotChunk(request);
		},
	};
	const syncErrors: unknown[] = [];
	const first = await openWorkspaceReplica(definition, {
		storage: { kind: 'memory' },
		sync,
		onSyncError: (error) => syncErrors.push(error),
		onObserverError: (error) => syncErrors.push(error),
		pollIntervalMs: 5,
	});
	const second = await openWorkspaceReplica(definition, {
		storage: { kind: 'memory' },
		sync,
		onSyncError: (error) => syncErrors.push(error),
		onObserverError: (error) => syncErrors.push(error),
		pollIntervalMs: 5,
	});

	try {
		await first.tables.notes.put({ id: 'shared', title: 'Automatic' });
		await waitUntil(
			async () =>
				(await second.tables.notes.get('shared'))?.title === 'Automatic',
		);
		expect(second.kind).toBe('replica');
		expect(syncErrors).toEqual([]);
	} finally {
		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		authorityDatabase.close();
	}
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await Bun.sleep(5);
	}
	throw new Error('Timed out waiting for replica convergence');
}
