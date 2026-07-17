/**
 * Honeycrisp SQLite Workspace Tests
 *
 * Exercises Honeycrisp's inert definition through the real Bun row runtime.
 *
 * Key behaviors:
 * - the runtime mints structural row ids
 * - folder deletion unsets note foreign keys before deleting the folder
 * - row-owned note documents survive runtime disposal and reopen
 * - row deletion revokes an already-open note document
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import { createDeviceBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import { deleteHoneycrispFolder, honeycrispWorkspace } from './index.js';

test('runtime-minted rows support optional fields and folder re-parenting', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-'));
	try {
		await using runtime = createDeviceBunWorkspaceRuntime({ storageRoot });
		const honeycrisp = await runtime.open(honeycrispWorkspace);
		const folder = await honeycrisp.tables.folders.create({
			name: 'Projects',
			sortOrder: 0,
		});
		const now = InstantString.now();
		const note = await honeycrisp.tables.notes.create({
			folderId: folder.id,
			title: 'Cut over Honeycrisp',
			preview: 'Use canonical rows',
			pinned: false,
			createdAt: now,
			updatedAt: now,
		});

		expect(note.id).toBeString();
		expect(note.id).not.toBe(folder.id);
		await deleteHoneycrispFolder(honeycrisp, folder.id);

		const folders = await honeycrisp.tables.folders.list();
		const notes = await honeycrisp.tables.notes.list();
		expect(folders.rows).toEqual([]);
		expect(notes.nonconforming).toEqual([]);
		expect(notes.rows).toHaveLength(1);
		expect(notes.rows[0]).toMatchObject({
			id: note.id,
			title: note.title,
		});
		expect(notes.rows[0]).not.toHaveProperty('folderId');
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('note body documents remain durable across runtime reopen', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-'));
	try {
		let noteId: string;
		{
			await using runtime = createDeviceBunWorkspaceRuntime({ storageRoot });
			const honeycrisp = await runtime.open(honeycrispWorkspace);
			const now = InstantString.now();
			const note = await honeycrisp.tables.notes.create({
				title: 'Durable body',
				preview: '',
				pinned: false,
				createdAt: now,
				updatedAt: now,
			});
			noteId = note.id;
			using document = await honeycrisp.tables.notes.document.open(note.id);
			const body = document.get('body');
			document.transact(() => body.insert(0, 'Persisted body'));
			await document.whenDurable();
		}

		await using reopenedRuntime = createDeviceBunWorkspaceRuntime({
			storageRoot,
		});
		const reopened = await reopenedRuntime.open(honeycrispWorkspace);
		using document = await reopened.tables.notes.document.open(noteId);
		expect(document.get('body').toString()).toBe('Persisted body');
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

test('deleting a note revokes its open body document', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-'));
	try {
		await using runtime = createDeviceBunWorkspaceRuntime({ storageRoot });
		const honeycrisp = await runtime.open(honeycrispWorkspace);
		const now = InstantString.now();
		const note = await honeycrisp.tables.notes.create({
			title: 'Delete me',
			preview: '',
			pinned: false,
			createdAt: now,
			updatedAt: now,
		});
		using document = await honeycrisp.tables.notes.document.open(note.id);

		await honeycrisp.tables.notes.delete(note.id);

		expect(() => document.get('body')).toThrow('was revoked');
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});
