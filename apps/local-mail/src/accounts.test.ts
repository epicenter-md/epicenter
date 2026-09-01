/**
 * Connecting and disconnecting, and what happens when the secret owner refuses.
 *
 * The registry, the credential, and the two SQLite partitions are addressed by
 * one `accountId`, so the tests that matter here are the ones about identity
 * (a reconnected subject must land on the row it already has) and about the
 * secret owner failing (a row without a credential must not read as connected).
 */

import { expect, test } from 'bun:test';
import type { LocalData } from '@epicenter/data';
import { openMemory } from '@epicenter/data/memory';
import { Ok } from 'wellcrafted/result';
import type { EpicenterHandle, SecretStore } from '@epicenter/app';
import {
	createMailApp,
	disconnectAccount,
	finishConnect,
	listAccounts,
	openSession,
} from './accounts.ts';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import { DEFAULT_MAIL_CONFIG } from './config.ts';
import database from './database.ts';
import { openMailbox } from './mailbox.ts';
import { openIntentStore } from './intent-store.ts';
import type { AuthorizationRequest } from './oauth.ts';
import {
	LOCAL_MAIL_APP_ID,
	MAIL_CACHE_SCHEMA,
	MAIL_INTENT_SCHEMA,
} from './storage.ts';

const IDENTITY = { clientId: 'client-id-123', clientSecret: 'client-secret' };
const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');

/** An id_token the way a client reads one back from the token endpoint. */
function idToken(sub: string, email: string): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString('base64url');
	const issued = Math.floor(Date.now() / 1000);
	return `${encode({ alg: 'RS256' })}.${encode({
		iss: 'https://accounts.google.com',
		aud: IDENTITY.clientId,
		exp: issued + 3600,
		iat: issued,
		sub,
		email,
	})}.signature`;
}

function secretStore(options: { refuse?: 'put' | 'delete' } = {}) {
	const held = new Map<string, string>();
	const refused = () =>
		({
			data: null,
			error: {
				name: 'StorageFailed',
				message: 'The secret owner failed.',
				cause: 'test',
			},
		}) as ReturnType<SecretStore['put']> extends Promise<infer R> ? R : never;
	const secrets: SecretStore = {
		put: async (accountId, value) => {
			if (options.refuse === 'put') return refused();
			held.set(accountId, value);
			return Ok(undefined);
		},
		get: async (accountId) => Ok(held.get(accountId) ?? null),
		delete: async (accountId) => {
			if (options.refuse === 'delete') return refused();
			held.delete(accountId);
			return Ok(undefined);
		},
	};
	return { secrets, held };
}

async function openApp(options: { refuse?: 'put' | 'delete' } = {}) {
	const data = await openMemory(database);
	const mail = createTestAppSqlite();
	const intent = createTestAppSqlite();
	for (const sql of MAIL_CACHE_SCHEMA) await mail.run(sql);
	for (const sql of MAIL_INTENT_SCHEMA) await intent.run(sql);
	const { secrets, held } = secretStore(options);
	const epicenter = {
		appId: LOCAL_MAIL_APP_ID,
		openData: async () => Ok(data),
		openSqlite: async () => Ok(mail),
		secrets,
	} as unknown as EpicenterHandle;

	const app = createMailApp({
		epicenter,
		storage: {
			// `openMemory` hands back an ACCOUNT store and the handle's `openData`
			// promises a LOCAL one. Nothing here touches `sync`, so the cast is
			// about the fixture rather than about the difference; the difference
			// itself is a real gap and is recorded on `openData`.
			data: data as unknown as LocalData<typeof database>,
			mail,
			intent,
			accounts: data.tables.accounts,
			folder: { local: 'local', account: 'account' },
		},
		identity: IDENTITY,
		config: DEFAULT_MAIL_CONFIG,
		now: NOW,
	});
	return {
		app,
		held,
		mail,
		intent,
		close: () => {
			mail.close();
			intent.close();
		},
	};
}

/** A token endpoint that answers one authorization with `sub` and `email`. */
function googleServing(sub: string, email: string, refreshToken: string) {
	return Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () =>
			Response.json({
				token_type: 'Bearer',
				access_token: 'access-token',
				refresh_token: refreshToken,
				expires_in: 3600,
				id_token: idToken(sub, email),
			}),
	});
}

function authorization(tokenUrl: string): {
	request: AuthorizationRequest;
	callbackUrl: URL;
} {
	const redirectUri = 'http://127.0.0.1:39130/apps/mail/connected';
	const callbackUrl = new URL(redirectUri);
	callbackUrl.searchParams.set('code', 'auth-code');
	callbackUrl.searchParams.set('state', 'state-value');
	return {
		request: {
			authorizeUrl: `${tokenUrl}?x=1`,
			state: 'state-value',
			codeVerifier: 'verifier-'.padEnd(48, 'x'),
			redirectUri,
		},
		callbackUrl,
	};
}

test('reconnecting one Google subject lands on the row it already has', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const first = await finishConnect(opened.app, authorization(tokenUrl));
		if (first.error !== null) throw first.error;

		// The person's address changed at Google; the subject did not.
		server.stop(true);
		const second = googleServing(
			'google-sub-1',
			'new@example.com',
			'refresh-2',
		);
		opened.app.config = {
			...DEFAULT_MAIL_CONFIG,
			tokenUrl: `http://127.0.0.1:${second.port}/token`,
		};
		const again = await finishConnect(
			opened.app,
			authorization(`http://127.0.0.1:${second.port}/token`),
		);
		second.stop(true);
		if (again.error !== null) throw again.error;

		// One row, not two: a second row would orphan the first account's cache
		// and intent partitions behind an id nothing reaches.
		expect(again.data.accountId).toBe(first.data.accountId);
		expect(listAccounts(opened.app)).toHaveLength(1);
		expect(listAccounts(opened.app)[0]?.email).toBe('new@example.com');
		expect(opened.held.get(first.data.accountId)).toBe('refresh-2');
	} finally {
		opened.close();
	}
});

test('a credential that did not store is a failed connection', async () => {
	const opened = await openApp({ refuse: 'put' });
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const result = await finishConnect(opened.app, authorization(tokenUrl));

		// Reporting Ok here would put an account in the switcher whose first
		// synchronization asks for re-consent with nothing to explain why.
		expect(result.error?.name).toBe('StorageFailed');
		expect(opened.held.size).toBe(0);
	} finally {
		server.stop(true);
		opened.close();
	}
});

test('a credential that would not delete stops the disconnect', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const connected = await finishConnect(opened.app, authorization(tokenUrl));
		if (connected.error !== null) throw connected.error;
		const { accountId } = connected.data;

		// There is no `secrets.list`, so the row is the only thing that knows this
		// credential exists. Removing it after a failed delete would strand the
		// credential where nothing can ever name it again.
		const refusing = await openApp({ refuse: 'delete' });
		refusing.app.storage = opened.app.storage;
		const stopped = await disconnectAccount(refusing.app, accountId);
		expect(stopped.error?.name).toBe('StorageFailed');
		expect(listAccounts(opened.app)).toHaveLength(1);
		refusing.close();

		const gone = await disconnectAccount(opened.app, accountId);
		expect(gone.error).toBeNull();
		expect(listAccounts(opened.app)).toEqual([]);
		expect(opened.held.size).toBe(0);
	} finally {
		server.stop(true);
		opened.close();
	}
});

test('disconnecting clears the cache and leaves undelivered triage alone', async () => {
	const opened = await openApp();
	const server = googleServing('google-sub-1', 'you@example.com', 'refresh-1');
	const tokenUrl = `http://127.0.0.1:${server.port}/token`;
	opened.app.config = { ...DEFAULT_MAIL_CONFIG, tokenUrl };
	try {
		const connected = await finishConnect(opened.app, authorization(tokenUrl));
		if (connected.error !== null) throw connected.error;
		const { accountId } = connected.data;

		const mailbox = openMailbox(opened.mail, accountId);
		const intents = openIntentStore(opened.intent, accountId);
		await mailbox.ingestFullPullPage(
			[
				{
					id: 'm1',
					threadId: 't1',
					labelIds: ['INBOX'],
					internalDate: '1700000000000',
					payload: { headers: [] },
				} as never,
			],
			'2026-07-01T00:00:00.000Z',
		);
		await intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			'2026-07-01T00:00:00.000Z',
		);

		const gone = await disconnectAccount(opened.app, accountId);
		expect(gone.error).toBeNull();
		expect((await mailbox.counts()).messages).toBe(0);
		// Disconnecting is not a statement that a person takes their triage back.
		expect((await intents.summary()).assertions).toBe(1);
	} finally {
		server.stop(true);
		opened.close();
	}
});

test('a session is scoped to the account it was opened for', async () => {
	const opened = await openApp();
	try {
		const session = openSession(opened.app, 'account-one');
		expect(session.accountId).toBe('account-one');
		expect(session.mailbox.accountId).toBe('account-one');
		expect(session.intents.accountId).toBe('account-one');
	} finally {
		opened.close();
	}
});
