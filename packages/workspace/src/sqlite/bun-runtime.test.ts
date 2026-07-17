/**
 * Bun Workspace Runtime Tests
 *
 * Verifies file-backed local persistence and the Bun runtime's background
 * RowIntent transport wiring.
 *
 * Key behaviors:
 * - rows, KV, and row documents survive runtime close and reopen
 * - synchronized local writes reach an in-process workspace authority
 */

import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { expectOk } from 'wellcrafted/testing';
import { devicePersistenceKey } from './account-runtime.js';
import {
	createAccountBunWorkspaceRuntime,
	createDeviceBunWorkspaceRuntime,
} from './bun-runtime.js';
import { defineTable } from './lens-definition.js';
import {
	createTestTransport,
	openTestAuthority,
} from './row-sync-test-utils.js';
import { defineWorkspace } from './runtime-definition.js';

const definition = defineWorkspace({
	id: 'bun-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: {
		theme: field.select(['light', 'dark']),
		language: field.string(),
		deviceFlag: field.boolean(),
	},
});

test('local Bun runtime reopens durable rows, KV, and documents', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-runtime-'));
	try {
		let rowId = '';
		{
			await using runtime = createDeviceBunWorkspaceRuntime({
				storageRoot: root,
			});
			const workspace = await runtime.open(definition);
			const row = await workspace.tables.notes.create({ title: 'Durable' });
			rowId = row.id;
			expectOk(await workspace.kv.set('theme', 'dark'));
			using document = await workspace.tables.notes.document.open(row.id);
			document.get('editor').insert(0, 'persisted');
			await document.whenDurable();
		}

		await using reopened = createDeviceBunWorkspaceRuntime({
			storageRoot: root,
		});
		const workspace = await reopened.open(definition);
		expect(expectOk(await workspace.tables.notes.get(rowId))?.title).toBe(
			'Durable',
		);
		expect(expectOk(await workspace.kv.get('theme'))).toBe('dark');
		using document = await workspace.tables.notes.document.open(rowId);
		expect(document.get('editor').toString()).toBe('persisted');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('synchronized Bun runtime sends RowIntents through enroll and sync', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-sync-'));
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	try {
		await using runtime = createAccountBunWorkspaceRuntime({
			storageRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await runtime.open(definition);
		const row = await workspace.tables.notes.create({ title: 'Synced' });
		await waitFor(() => authorityState.authority.inspect().rows.length === 1);
		expect(authorityState.authority.inspect().rows[0]).toMatchObject({
			rowId: row.id,
			fields: { title: 'Synced' },
		});
		await workspace.tables.notes.delete(row.id);
		await waitFor(() => authorityState.authority.inspect().rows.length === 0);
		expect(transport.enrollRequests).toHaveLength(1);
		expect(transport.syncRequests.length).toBeGreaterThanOrEqual(2);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('Account open adds Device state, deletes its source, then synchronizes', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-add-'));
	const authorityState = openTestAuthority();
	const base = createTestTransport(authorityState.authority);
	const sourcePath = deviceWorkspacePath(root);
	try {
		let rowId = '';
		{
			await using device = createDeviceBunWorkspaceRuntime({
				storageRoot: root,
			});
			const workspace = await device.open(definition);
			const row = await workspace.tables.notes.create({ title: 'Device' });
			rowId = row.id;
			expectOk(await workspace.kv.set('theme', 'dark'));
			using document = await workspace.tables.notes.document.open(row.id);
			document.get('editor').insert(0, 'device draft');
			await document.whenDurable();
		}
		expect(existsSync(sourcePath)).toBe(true);

		await using accountRuntime = createAccountBunWorkspaceRuntime({
			storageRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => ({
					enroll(request) {
						expect(existsSync(sourcePath)).toBe(false);
						return base.enroll(request);
					},
					sync(request) {
						expect(existsSync(sourcePath)).toBe(false);
						return base.sync(request);
					},
					baselineScan: base.baselineScan,
				}),
			},
			recordPollIntervalMs: 60_000,
		});
		const workspace = await accountRuntime.open(definition);
		expect(existsSync(sourcePath)).toBe(false);
		expect(existsSync(`${sourcePath}-wal`)).toBe(false);
		expect(existsSync(`${sourcePath}-shm`)).toBe(false);
		expect(expectOk(await workspace.tables.notes.get(rowId))?.title).toBe(
			'Device',
		);
		expect(expectOk(await workspace.kv.get('theme'))).toBe('dark');
		using document = await workspace.tables.notes.document.open(rowId);
		expect(document.get('editor').toString()).toBe('device draft');
		await waitFor(() =>
			authorityState.authority
				.inspect()
				.rows.some((row) => row.rowId === rowId),
		);
		expect(
			authorityState.authority.inspect().rows.find((row) => row.rowId === rowId)
				?.rowId,
		).toBe(rowId);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('corrupt Device storage rejects Account open without synchronization', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-add-corrupt-'));
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	const sourcePath = deviceWorkspacePath(root);
	try {
		{
			await using device = createDeviceBunWorkspaceRuntime({
				storageRoot: root,
			});
			const workspace = await device.open(definition);
			await workspace.tables.notes.create({ title: 'Device' });
		}
		expect(existsSync(sourcePath)).toBe(true);
		rmSync(`${sourcePath}-wal`, { force: true });
		rmSync(`${sourcePath}-shm`, { force: true });
		writeFileSync(sourcePath, 'not a sqlite database');
		await using account = createAccountBunWorkspaceRuntime({
			storageRoot: root,
			account: {
				deploymentId: 'https://example.test',
				principalId: asPrincipalId('alice'),
				transport: () => transport,
			},
		});
		await expect(account.open(definition)).rejects.toThrow();
		expect(existsSync(sourcePath)).toBe(true);
		expect(transport.enrollRequests).toEqual([]);
		expect(transport.syncRequests).toEqual([]);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('Account runtime exclusively owns Device and Account roots', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-ownership-'));
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	const accountOptions = {
		storageRoot: root,
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: () => transport,
		},
	};
	try {
		const device = createDeviceBunWorkspaceRuntime({ storageRoot: root });
		expect(() => createAccountBunWorkspaceRuntime(accountOptions)).toThrow(
			'already has an owner',
		);
		await device[Symbol.asyncDispose]();

		const account = createAccountBunWorkspaceRuntime(accountOptions);
		expect(() =>
			createDeviceBunWorkspaceRuntime({ storageRoot: root }),
		).toThrow('already has an owner');
		expect(() => createAccountBunWorkspaceRuntime(accountOptions)).toThrow(
			'already has an owner',
		);
		await account[Symbol.asyncDispose]();

		await using released = createDeviceBunWorkspaceRuntime({
			storageRoot: root,
		});
		await released.open(definition);
	} finally {
		authorityState.database.close();
		rmSync(root, { recursive: true, force: true });
	}
});

function deviceWorkspacePath(root: string): string {
	return join(root, devicePersistenceKey(), `${definition.id}.records.sqlite3`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for sync');
		await Bun.sleep(10);
	}
}
