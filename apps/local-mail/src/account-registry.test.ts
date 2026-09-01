import { expect, test } from 'bun:test';
import { openMemory } from '@epicenter/data/memory';
import {
	accountById,
	registerAccount,
	type AccountRecord,
} from './account-registry.ts';
import database from './database.ts';

test('account registry uses the generated Epicenter row id', async () => {
	await using data = await openMemory(database);
	const accountId = registerAccount(data.tables.accounts, {
		provider: 'gmail',
		providerAccountId: 'google-sub-1',
		email: 'person@example.com',
		connectedAt: '2026-08-31T00:00:00.000Z' as AccountRecord['connectedAt'],
		lastSyncedAt: null,
	});

	expect(accountId).not.toBe('google-sub-1');
	expect(accountById(data.tables.accounts, accountId)).toMatchObject({
		providerAccountId: 'google-sub-1',
		email: 'person@example.com',
	});
});
