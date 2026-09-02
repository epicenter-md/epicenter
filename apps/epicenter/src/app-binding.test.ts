import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpicenter } from '@epicenter/app';
import { createHostBinding } from './app-binding.ts';
import { createProcessMemoryAppSecrets } from './app-secrets.ts';
import { createBunAppStorage } from './app-storage.ts';

const APP = 'so.epicenter.mail';

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

	const opened = await epicenter.openSqlite('mail');
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

	expect((await epicenter.secrets.get('sub-one')).data).toBeNull();
	expect((await epicenter.secrets.put('sub-one', 'refresh')).error).toBeNull();
	expect((await epicenter.secrets.get('sub-one')).data).toBe('refresh');
	expect((await epicenter.secrets.delete('sub-one')).error).toBeNull();
	expect((await epicenter.secrets.get('sub-one')).data).toBeNull();
});

test('deleting a database through the host leaf removes the file', async () => {
	const { root, epicenter } = await hostHandle();
	const path = join(root, 'apps', APP, 'sqlite', 'mail.sqlite');

	const opened = await epicenter.openSqlite('mail');
	if (opened.error !== null) throw opened.error;
	await opened.data.run('CREATE TABLE messages (id TEXT)');
	expect(await Bun.file(path).exists()).toBe(true);

	expect((await epicenter.deleteSqlite('mail')).error).toBeNull();
	expect(await Bun.file(path).exists()).toBe(false);
});

test('the host holds no store, and says so rather than pretending', async () => {
	const { epicenter } = await hostHandle();

	// A background half that asked for Epicenter Data is asking for something
	// no runtime gives it here: the store is client-owned (ADR-0226), and this
	// leaf answers with that rather than minting an empty one.
	const result = await epicenter.openData(
		{ id: APP } as never,
		undefined as never,
	);
	expect(result.error?.name).toBe('StorageFailed');
	const failure = result.error as { cause?: unknown } | null;
	expect(String(failure?.cause)).toContain('client-owned');
});
