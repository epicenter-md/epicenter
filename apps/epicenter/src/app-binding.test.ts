import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpicenter, databaseName, secretLabel } from '@epicenter/app';
import { createHostBinding } from './app-binding.ts';
import { createProcessMemoryAppSecrets } from './app-secrets.ts';
import { createBunAppStorage } from './app-storage.ts';

const APP = 'so.epicenter.mail';
const MAIL = databaseName('mail');
const SUB_ONE = secretLabel('sub-one');

async function hostHandle() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-host-binding-'));
	const storage = createBunAppStorage(root);
	return {
		root,
		storage,
		epicenter: createEpicenter({
			appId: APP,
			binding: createHostBinding({
				appId: APP,
				storage,
				secrets: createProcessMemoryAppSecrets(),
			}),
		}),
	};
}

test('the host leaf reaches the same connection a window would have reached', async () => {
	const { storage, epicenter } = await hostHandle();

	const opened = await epicenter.sqlite.open(MAIL);
	if (opened.error !== null) throw opened.error;
	await opened.data.run('CREATE TABLE messages (id TEXT)');
	await opened.data.run('INSERT INTO messages VALUES (?)', ['one']);

	// What the window's round trip resolves to is `storage.open(appId, name)`,
	// so a background half is not a second writer on this database. It is the
	// same connection, and the owner serializes it (ADR-0323).
	const throughTheOwner = await storage.open(APP, 'mail');
	expect(throughTheOwner).toBe(opened.data);
	expect((await throughTheOwner.all('SELECT id FROM messages')).data).toEqual([
		{ id: 'one' },
	]);
});

test('the host leaf holds secrets and scopes them to its application', async () => {
	const { epicenter } = await hostHandle();

	expect((await epicenter.secrets.get(SUB_ONE)).data).toBeNull();
	expect((await epicenter.secrets.put(SUB_ONE, 'refresh')).error).toBeNull();
	expect((await epicenter.secrets.get(SUB_ONE)).data).toBe('refresh');
	expect((await epicenter.secrets.delete(SUB_ONE)).error).toBeNull();
	expect((await epicenter.secrets.get(SUB_ONE)).data).toBeNull();
});

test('deleting a database through the host leaf removes the file', async () => {
	const { root, epicenter } = await hostHandle();
	const path = join(root, 'apps', APP, 'sqlite', 'mail.sqlite');

	const opened = await epicenter.sqlite.open(MAIL);
	if (opened.error !== null) throw opened.error;
	await opened.data.run('CREATE TABLE messages (id TEXT)');
	expect(await Bun.file(path).exists()).toBe(true);

	expect((await epicenter.sqlite.delete(MAIL)).error).toBeNull();
	expect(await Bun.file(path).exists()).toBe(false);
});
