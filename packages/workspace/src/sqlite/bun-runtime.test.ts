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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { createBunWorkspaceRuntime } from './bun-runtime.js';
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
	kv: { theme: field.select(['light', 'dark']) },
});

test('local Bun runtime reopens durable rows, KV, and documents', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-bun-runtime-'));
	try {
		let rowId: string;
		{
			await using runtime = createBunWorkspaceRuntime({
				storageScopeKey: 'local-storage-scope',
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

		await using reopened = createBunWorkspaceRuntime({
			storageScopeKey: 'local-storage-scope',
			storageRoot: root,
		});
		const workspace = await reopened.open(definition);
		expect(expectOk(await workspace.tables.notes.get(rowId!))?.title).toBe(
			'Durable',
		);
		expect(expectOk(await workspace.kv.get('theme'))).toBe('dark');
		using document = await workspace.tables.notes.document.open(rowId!);
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
		await using runtime = createBunWorkspaceRuntime({
			storageScopeKey: 'remote-storage-scope',
			storageRoot: root,
			recordTransport: () => transport,
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

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for sync');
		await Bun.sleep(10);
	}
}
