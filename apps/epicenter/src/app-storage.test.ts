import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunAppStorage } from './app-storage.ts';

test('application SQLite is scoped, async, and batch is atomic', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-app-storage-'));
	const storage = createBunAppStorage(root);
	const first = await storage.open('so.epicenter.mail', 'mail');
	const second = await storage.open('so.epicenter.other', 'mail');

	const schema = await first.batch([
		{ sql: 'CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT)' },
		{ sql: 'INSERT INTO messages VALUES (?, ?)', parameters: ['one', 'Hello'] },
	]);
	expect(schema.error).toBeNull();

	const rows = await first.all<{ id: string; subject: string }>(
		'SELECT id, subject FROM messages',
	);
	expect(rows.data).toEqual([{ id: 'one', subject: 'Hello' }]);

	const failed = await first.batch([
		{ sql: 'INSERT INTO messages VALUES (?, ?)', parameters: ['two', 'World'] },
		{ sql: 'INSERT INTO missing VALUES (?)', parameters: ['never'] },
	]);
	expect(failed.error).not.toBeNull();
	const afterFailure = await first.all<{ id: string }>('SELECT id FROM messages');
	expect(afterFailure.data).toEqual([{ id: 'one' }]);

	const isolated = await second.all('SELECT name FROM sqlite_master');
	expect(isolated.data).toEqual([]);
	await second.run('CREATE TABLE only_here (id TEXT)');
	const mailPath = join(root, 'apps', 'so.epicenter.mail', 'sqlite', 'mail.sqlite');
	const otherPath = join(root, 'apps', 'so.epicenter.other', 'sqlite', 'mail.sqlite');
	expect(Bun.file(mailPath).size).toBeGreaterThan(0);
	expect(Bun.file(otherPath).size).toBeGreaterThan(0);
});
