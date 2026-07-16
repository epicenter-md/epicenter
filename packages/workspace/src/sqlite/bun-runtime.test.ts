/**
 * Bun Workspace Runtime Tests
 *
 * Verifies the production Bun record-owner door uses one lazy durable SQLite
 * file per workspace and releases ownership when the runtime closes.
 *
 * Key behaviors:
 * - opening a workspace does not create its records file
 * - canonical rows survive closing and reopening the runtime
 * - two live runtimes cannot own the same records file
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import {
	openRecordAuthority,
	RECORD_SYNC_ADMISSION_LIMITS,
	RECORD_SYNC_PROTOCOL_MAJOR,
	type RecordCommand,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { expectOk } from 'wellcrafted/testing';
import { createBunWorkspaceRuntime } from './bun-runtime.js';
import type { CanonicalReplicaTransport } from './canonical-replica.js';
import { document } from './document-definition.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const definition = defineWorkspace({
	id: 'skills',
	tables: {
		skills: defineTable({ fields: { title: field.string() } }),
	},
	documents: {
		preferences: document.keyValue({ entries: { theme: field.string() } }),
	},
});

async function sha256(value: string): Promise<string> {
	return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function createAuthority() {
	const native = new Database(':memory:');
	const authority = openRecordAuthority({
		database: createBunSqliteAdapter(native),
		sha256,
	});
	const transport: CanonicalReplicaTransport = {
		async push(request) {
			return authority.push(request);
		},
		async pull(request) {
			return authority.pull(request);
		},
		async snapshotChunk(request) {
			return authority.snapshotChunk(request);
		},
	};
	return { native, authority, transport };
}

function seedAuthority(
	authority: ReturnType<typeof openRecordAuthority>,
	actorId: string,
	commands: RecordCommand[],
): void {
	const response = authority.push({
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		actorId,
		mutations: commands.map((command, index) => ({
			actorSequence: index + 1,
			command,
		})),
	});
	if (!response.ok) throw new Error(`Seed push refused: ${response.reason}`);
}

function authorityHasRow(
	authority: ReturnType<typeof openRecordAuthority>,
	rowId: string,
): boolean {
	const response = authority.pull({
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'pull',
		cursor: 0,
		limit: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
	});
	return (
		response.ok &&
		!response.snapshotRequired &&
		response.entries.some(
			(entry) => entry.kind === 'row' && entry.rowId === rowId,
		)
	);
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(5);
	}
	throw new Error('Timed out waiting for background synchronization');
}

test('Bun runtime lazily persists one canonical records file', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-runtime-'));
	const path = join(storageRoot, 'skills.records.sqlite3');
	const invalidations: string[] = [];
	try {
		const firstRuntime = createBunWorkspaceRuntime({
			authorityKey: 'local-device',
			storageRoot,
			onRecordsChanged(workspaceId) {
				invalidations.push(workspaceId);
			},
		});
		const first = await firstRuntime.open(definition);
		expect(existsSync(path)).toBe(false);
		const created = await first.tables.skills.create({ title: 'Durable' });
		await waitFor(() => invalidations.includes('skills'));
		expect(existsSync(path)).toBe(true);
		const preferences = await first.documents.preferences.open();
		preferences.content.set('theme', 'dark');
		preferences[Symbol.dispose]();

		expect(() =>
			createBunWorkspaceRuntime({
				authorityKey: 'local-device',
				storageRoot,
			}),
		).toThrow('runtime storage already has an owner');

		await firstRuntime[Symbol.asyncDispose]();
		expect(
			readFileSync(join(storageRoot, '.epicenter-runtime.json'), 'utf8'),
		).not.toContain('local-device');
		expect(() =>
			createBunWorkspaceRuntime({
				authorityKey: 'another-authority',
				storageRoot,
			}),
		).toThrow('storage belongs to another authority');
		await using reopenedRuntime = createBunWorkspaceRuntime({
			authorityKey: 'local-device',
			storageRoot,
		});
		const reopened = await reopenedRuntime.open(definition);
		expect(expectOk(await reopened.tables.skills.get(created.id))).toEqual(
			created,
		);
		await using reopenedPreferences =
			await reopened.documents.preferences.open();
		expect(expectOk(reopenedPreferences.content.get('theme'))).toBe('dark');
		expect(
			readdirSync(storageRoot, { recursive: true }).some((name) =>
				String(name).endsWith('.tmp'),
			),
		).toBe(false);
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('Bun runtime pulls on startup and pushes local writes without public sync controls', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-runtime-sync-'));
	const remote = createAuthority();
	seedAuthority(remote.authority, 'remote-seed', [
		{
			kind: 'createRow',
			table: 'skills',
			rowId: 'remote-skill',
			value: { title: 'From authority' },
		},
	]);
	const invalidations: string[] = [];
	let transportBindings = 0;
	let pulls = 0;
	try {
		await using runtime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			recordTransport(workspaceId) {
				expect(workspaceId).toBe('skills');
				transportBindings += 1;
				return {
					...remote.transport,
					async pull(request) {
						pulls += 1;
						return remote.transport.pull(request);
					},
				};
			},
			recordPollIntervalMs: 10,
			onRecordsChanged(workspaceId) {
				invalidations.push(workspaceId);
			},
		});
		const [first, reopened] = await Promise.all([
			runtime.open(definition),
			runtime.open(definition),
		]);
		expect(first).toBe(reopened);
		expect('synchronize' in runtime).toBe(false);
		expect('synchronize' in first).toBe(false);

		await waitFor(async () => {
			const row = expectOk(await first.tables.skills.get('remote-skill'));
			return row?.title === 'From authority';
		});
		expect(transportBindings).toBe(1);
		expect(invalidations).toContain('skills');

		const created = await first.tables.skills.create({ title: 'Local write' });
		await waitFor(() => authorityHasRow(remote.authority, created.id));
		await runtime[Symbol.asyncDispose]();
		const pullsAfterDisposal = pulls;
		await Bun.sleep(30);
		expect(pulls).toBe(pullsAfterDisposal);
	} finally {
		remote.native.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('Bun runtime recovers a durable outbox after restart', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-runtime-retry-'));
	const remote = createAuthority();
	const syncErrors: unknown[] = [];
	try {
		const offlineRuntime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			recordTransport: () => ({
				...remote.transport,
				async push() {
					throw new Error('offline');
				},
			}),
			recordPollIntervalMs: 10,
			onSyncError(cause) {
				syncErrors.push(cause);
			},
		});
		const offline = await offlineRuntime.open(definition);
		const created = await offline.tables.skills.create({ title: 'Retry me' });
		await waitFor(() => syncErrors.length > 0);
		expect(authorityHasRow(remote.authority, created.id)).toBe(false);
		await offlineRuntime[Symbol.asyncDispose]();

		await using recoveredRuntime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			recordTransport: () => remote.transport,
			recordPollIntervalMs: 10,
		});
		const recovered = await recoveredRuntime.open(definition);
		expect(expectOk(await recovered.tables.skills.get(created.id))).toEqual(
			created,
		);
		await waitFor(() => authorityHasRow(remote.authority, created.id));
	} finally {
		remote.native.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('Bun runtime disposal aborts a stalled record transport', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-runtime-abort-'));
	let pullStarted = false;
	try {
		const runtime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			recordTransport: () => ({
				async push() {
					return await new Promise<never>(() => undefined);
				},
				async pull() {
					pullStarted = true;
					return await new Promise<never>(() => undefined);
				},
				async snapshotChunk() {
					return await new Promise<never>(() => undefined);
				},
			}),
		});
		const skills = await runtime.open(definition);
		await skills.tables.skills.get('missing');
		await waitFor(() => pullStarted);

		await Promise.race([
			runtime[Symbol.asyncDispose](),
			Bun.sleep(500).then(() => {
				throw new Error('Runtime disposal did not abort stalled transport');
			}),
		]);

		await using reopened = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
		});
		const reopenedSkills = await reopened.open(definition);
		expect(await reopenedSkills.tables.skills.get('missing')).toEqual({
			data: null,
			error: null,
		});
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('Bun runtime disposal aborts a stalled transport factory', async () => {
	const storageRoot = mkdtempSync(
		join(tmpdir(), 'epicenter-runtime-factory-abort-'),
	);
	let factoryStarted = false;
	try {
		const runtime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			async recordTransport() {
				factoryStarted = true;
				return await new Promise<never>(() => undefined);
			},
		});
		const skills = await runtime.open(definition);
		const pendingRead = skills.tables.skills
			.get('missing')
			.catch((cause) => cause);
		await waitFor(() => factoryStarted);

		await Promise.race([
			runtime[Symbol.asyncDispose](),
			Bun.sleep(500).then(() => {
				throw new Error('Runtime disposal did not abort transport factory');
			}),
		]);
		expect(await pendingRead).toBeDefined();

		await using reopened = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
		});
		const reopenedSkills = await reopened.open(definition);
		expect(await reopenedSkills.tables.skills.get('missing')).toEqual({
			data: null,
			error: null,
		});
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('Bun runtime disposal aborts a stalled push and preserves its outbox', async () => {
	const storageRoot = mkdtempSync(
		join(tmpdir(), 'epicenter-runtime-push-abort-'),
	);
	const remote = createAuthority();
	let pushStarted = false;
	try {
		const runtime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			recordTransport: () => ({
				...remote.transport,
				async push() {
					pushStarted = true;
					return await new Promise<never>(() => undefined);
				},
			}),
		});
		const skills = await runtime.open(definition);
		const created = await skills.tables.skills.create({ title: 'Pending' });
		await waitFor(() => pushStarted);

		await Promise.race([
			runtime[Symbol.asyncDispose](),
			Bun.sleep(500).then(() => {
				throw new Error('Runtime disposal did not abort stalled push');
			}),
		]);
		expect(authorityHasRow(remote.authority, created.id)).toBe(false);

		await using reopened = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			recordTransport: () => remote.transport,
			recordPollIntervalMs: 10,
		});
		const reopenedSkills = await reopened.open(definition);
		expect(
			expectOk(await reopenedSkills.tables.skills.get(created.id)),
		).toEqual(created);
		await waitFor(() => authorityHasRow(remote.authority, created.id));
	} finally {
		remote.native.close();
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('Bun runtime owns document sync attachment and cleanup', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-runtime-docs-'));
	let attached = 0;
	let detached = 0;
	try {
		const runtime = createBunWorkspaceRuntime({
			authorityKey: 'remote-account',
			storageRoot,
			attachDocumentSync(ydoc, storageRef) {
				expect(ydoc.guid).toBe(storageRef);
				attached += 1;
				return {
					[Symbol.dispose]() {
						detached += 1;
					},
				};
			},
		});
		const skills = await runtime.open(definition);
		const first = await skills.documents.preferences.open();
		const second = await skills.documents.preferences.open();
		expect(attached).toBe(1);
		first.content.set('theme', 'dark');
		first[Symbol.dispose]();
		second[Symbol.dispose]();
		await waitFor(() => detached === 1);

		const live = await skills.documents.preferences.open();
		expect(attached).toBe(2);
		expect(expectOk(live.content.get('theme'))).toBe('dark');
		await runtime[Symbol.asyncDispose]();
		expect(detached).toBe(2);
		expect(() => live.content.get('theme')).toThrow('runtime is disposed');
		live[Symbol.dispose]();
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});
