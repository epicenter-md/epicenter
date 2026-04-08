/**
 * End-to-end test: Honeycrisp workspace through the CLI pipeline.
 *
 * Uses the single-workspace fixture (one named export) to verify:
 *
 * Key behaviors:
 * - loadConfig() discovers exactly one workspace client from a single export
 * - Table CRUD works (set, getAllValid)
 * - KV works (get, set)
 * - SQLite persistence survives process restart
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHoneycrisp, honeycrisp } from '@epicenter/honeycrisp/workspace';
import { dateTimeStringNow } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { loadConfig } from '../src/load-config';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/single-workspace');
const PERSISTENCE_DIR = join(FIXTURE_DIR, '.epicenter-test');

function dbPath(id: string) {
	return join(PERSISTENCE_DIR, `${id}.db`);
}

describe('e2e: honeycrisp workspace', () => {
	beforeAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	test('loadConfig: discovers exactly one client from single export', async () => {
		const result = await loadConfig(FIXTURE_DIR);

		expect(result.clients).toHaveLength(1);
		expect(result.clients[0]!.id).toBe('epicenter.honeycrisp');
		expect(result.configDir).toBe(FIXTURE_DIR);
	});

	test('table CRUD: write and read folders + notes', async () => {
		const client = createHoneycrisp().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(honeycrisp.id) }),
		);

		await client.whenReady;

		// Write a folder
		client.tables.folders.set({
			id: 'folder-1',
			name: 'Work Notes',
			icon: undefined,
			sortOrder: 0,
			_v: 1,
		});

		// Write a note
		const now = dateTimeStringNow();
		client.tables.notes.set({
			id: 'note-1',
			folderId: 'folder-1',
			title: 'Test Note',
			preview: 'This is a test note from the e2e test',
			pinned: false,
			deletedAt: undefined,
			wordCount: 8,
			createdAt: now,
			updatedAt: now,
			_v: 2,
		});

		// Verify reads
		const folders = client.tables.folders.getAllValid();
		expect(folders).toHaveLength(1);
		expect(folders[0]!.name).toBe('Work Notes');

		const notes = client.tables.notes.getAllValid();
		expect(notes).toHaveLength(1);
		expect(notes[0]!.title).toBe('Test Note');
		expect(notes[0]!.folderId).toBe('folder-1');

		await client.dispose();
	});

	test('persistence: data survives restart', async () => {
		// Re-open same workspace — should load persisted state from SQLite
		const client = createHoneycrisp().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(honeycrisp.id) }),
		);

		await client.whenReady;

		const folders = client.tables.folders.getAllValid();
		expect(folders).toHaveLength(1);
		expect(folders[0]!.name).toBe('Work Notes');

		const notes = client.tables.notes.getAllValid();
		expect(notes).toHaveLength(1);
		expect(notes[0]!.title).toBe('Test Note');

		await client.dispose();
	});

	test('KV: set, persist, read after restart', async () => {
		// Open, set KV values, destroy
		const client1 = createHoneycrisp().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(honeycrisp.id) }),
		);
		await client1.whenReady;

		client1.kv.set('sortBy', 'title');
		client1.kv.set('sidebarCollapsed', true);

		await client1.dispose();

		// Re-open and verify
		const client2 = createHoneycrisp().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(honeycrisp.id) }),
		);
		await client2.whenReady;

		expect(client2.kv.get('sortBy')).toBe('title');
		expect(client2.kv.get('sidebarCollapsed')).toBe(true);

		await client2.dispose();
	});
});
