import { expect, test } from 'bun:test';
import type { Db } from '@epicenter/server/cloud-db';
import { createTikTokOAuthClient } from './oauth.js';
import { createTokenCipher, type TokenCipher } from './token-cipher.js';
import { ensureAccessToken } from './tokens.js';

const KEY = Buffer.from(new Uint8Array(32).fill(9)).toString('base64url');

async function cipherV1(): Promise<TokenCipher> {
	const { data, error } = await createTokenCipher([
		{ version: 1, base64Key: KEY },
	]);
	if (error) throw new Error(error.message);
	return data;
}

type Row = {
	id: string;
	openId: string;
	scopes: string[];
	accessTokenCiphertext: string;
	accessTokenExpiresAt: Date;
	refreshTokenCiphertext: string;
	refreshTokenExpiresAt: Date;
};

/**
 * A Postgres stand-in that models the ONE property under test: `SELECT ... FOR
 * UPDATE` serializes transactions touching the same row. Callers queue behind
 * the holder exactly as they would on a real row lock, so a race here is the
 * same race production would run.
 *
 * The `where` clauses are not evaluated; these tests drive a single connection.
 * Owner-scoping of reads is covered by the route tests instead.
 */
function fakeDb(row: Row) {
	const state = { row };
	let lock: Promise<unknown> = Promise.resolve();
	const counters = { locksTaken: 0, updates: 0 };

	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({
					for: () => ({
						limit: async () => {
							counters.locksTaken += 1;
							return [{ ...state.row }];
						},
					}),
				}),
			}),
		}),
		update: () => ({
			set: (values: Partial<Row>) => ({
				where: async () => {
					counters.updates += 1;
					state.row = { ...state.row, ...values };
				},
			}),
		}),
	};

	const db = {
		async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
			// Serialize on the row, as FOR UPDATE does.
			const run = lock.then(() => fn(tx));
			lock = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	} as unknown as Db;

	return { db, state, counters };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

/** A TikTok token endpoint stand-in that counts how many refreshes it served. */
function refreshEndpoint(
	grant: Record<string, unknown> = {
		access_token: 'act.rotated',
		expires_in: 86_400,
		refresh_token: 'rft.rotated',
		refresh_expires_in: 31_536_000,
		open_id: 'open-1',
		scope: 'user.info.basic,video.publish',
	},
) {
	const seen: string[] = [];
	const send = (async (_url: string | URL, init?: RequestInit) => {
		const form = new URLSearchParams(String(init?.body ?? ''));
		seen.push(form.get('refresh_token') ?? '');
		return jsonResponse(grant);
	}) as unknown as typeof globalThis.fetch;
	return { send, seen };
}

async function buildRow(
	cipher: TokenCipher,
	{
		accessExpiresInMs,
		refreshExpiresInMs = 30 * 24 * 60 * 60 * 1000,
	}: { accessExpiresInMs: number; refreshExpiresInMs?: number },
): Promise<Row> {
	const { data: accessCiphertext } = await cipher.encrypt('act.stored');
	const { data: refreshCiphertext } = await cipher.encrypt('rft.stored');
	return {
		id: 'conn-1',
		openId: 'open-1',
		scopes: ['user.info.basic', 'video.publish'],
		accessTokenCiphertext: accessCiphertext as string,
		accessTokenExpiresAt: new Date(Date.now() + accessExpiresInMs),
		refreshTokenCiphertext: refreshCiphertext as string,
		refreshTokenExpiresAt: new Date(Date.now() + refreshExpiresInMs),
	};
}

test('a still-fresh access token is decrypted and returned without contacting TikTok', async () => {
	const cipher = await cipherV1();
	const { db, counters } = fakeDb(
		await buildRow(cipher, { accessExpiresInMs: 60 * 60 * 1000 }),
	);
	const { send, seen } = refreshEndpoint();

	const { data, error } = await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	expect(error).toBeNull();
	expect(data?.accessToken).toBe('act.stored');
	expect(seen).toHaveLength(0);
	expect(counters.updates).toBe(0);
});

test('a token inside the refresh skirt is refreshed BEFORE it expires', async () => {
	const cipher = await cipherV1();
	// Two minutes left: still technically valid, but inside the 5-minute skirt,
	// so it would die mid-upload.
	const { db } = fakeDb(
		await buildRow(cipher, { accessExpiresInMs: 2 * 60 * 1000 }),
	);
	const { send, seen } = refreshEndpoint();

	const { data, error } = await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	expect(error).toBeNull();
	expect(data?.accessToken).toBe('act.rotated');
	expect(seen).toEqual(['rft.stored']);
});

test('the ROTATED refresh token is persisted, encrypted, alongside the new access token', async () => {
	const cipher = await cipherV1();
	const { db, state } = fakeDb(
		await buildRow(cipher, { accessExpiresInMs: -1000 }),
	);
	const { send } = refreshEndpoint();

	await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	// Losing the rotated refresh token would strand the grant at the next expiry.
	const { data: storedRefresh } = await cipher.decrypt(
		state.row.refreshTokenCiphertext,
	);
	const { data: storedAccess } = await cipher.decrypt(
		state.row.accessTokenCiphertext,
	);
	expect(storedRefresh).toBe('rft.rotated');
	expect(storedAccess).toBe('act.rotated');
	// Never stored in the clear.
	expect(state.row.refreshTokenCiphertext).toStartWith('v1.');
	expect(state.row.refreshTokenCiphertext).not.toContain('rft.rotated');
	expect(state.row.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
});

test('scopes are re-read on refresh, so a creator narrowing them is reflected', async () => {
	const cipher = await cipherV1();
	const { db, state } = fakeDb(
		await buildRow(cipher, { accessExpiresInMs: -1000 }),
	);
	const { send } = refreshEndpoint({
		access_token: 'act.rotated',
		expires_in: 86_400,
		refresh_token: 'rft.rotated',
		refresh_expires_in: 31_536_000,
		open_id: 'open-1',
		// The creator revoked video.publish from TikTok's own settings.
		scope: 'user.info.basic',
	});

	const { data } = await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	expect(data?.scopes).toEqual(['user.info.basic']);
	expect(state.row.scopes).toEqual(['user.info.basic']);
});

test("concurrent callers refresh EXACTLY ONCE: the loser reuses the winner's token", async () => {
	const cipher = await cipherV1();
	const { db, counters } = fakeDb(
		await buildRow(cipher, { accessExpiresInMs: -1000 }),
	);
	const { send, seen } = refreshEndpoint();
	const oauth = createTikTokOAuthClient({
		clientKey: 'ck',
		clientSecret: 'cs',
		fetch: send,
	});

	const results = await Promise.all(
		Array.from({ length: 5 }, () =>
			ensureAccessToken({ db, cipher, oauth, connectionId: 'conn-1' }),
		),
	);

	// This is the invariant that keeps a grant alive: TikTok rotates refresh
	// tokens, so a second concurrent refresh would present an already-spent token
	// and could permanently invalidate the connection.
	expect(seen).toEqual(['rft.stored']);
	expect(counters.locksTaken).toBe(5);
	expect(counters.updates).toBe(1);
	// Every caller still gets a usable token.
	for (const { data, error } of results) {
		expect(error).toBeNull();
		expect(data?.accessToken).toBe('act.rotated');
	}
});

test('an expired refresh token is refused with a reconnect remedy, and nothing is spent', async () => {
	const cipher = await cipherV1();
	const { db, counters } = fakeDb(
		await buildRow(cipher, {
			accessExpiresInMs: -1000,
			refreshExpiresInMs: -1000,
		}),
	);
	const { send, seen } = refreshEndpoint();

	const { data, error } = await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('RefreshTokenExpired');
	expect(error?.message).toContain('Reconnect');
	expect(seen).toHaveLength(0);
	expect(counters.updates).toBe(0);
});

test('a provider refusal leaves the stored tokens untouched', async () => {
	const cipher = await cipherV1();
	const row = await buildRow(cipher, { accessExpiresInMs: -1000 });
	const { db, state } = fakeDb(row);
	const send = (async () =>
		jsonResponse(
			{ error: 'invalid_grant', error_description: 'Refresh token revoked' },
			400,
		)) as unknown as typeof globalThis.fetch;

	const { data, error } = await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('ProviderRejected');
	// A failed refresh must not half-write: the row is exactly as it was.
	expect(state.row.refreshTokenCiphertext).toBe(row.refreshTokenCiphertext);
	expect(state.row.accessTokenCiphertext).toBe(row.accessTokenCiphertext);
});

test('a missing connection is reported rather than treated as an empty grant', async () => {
	const cipher = await cipherV1();
	const db = {
		async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
			return fn({
				select: () => ({
					from: () => ({
						where: () => ({ for: () => ({ limit: async () => [] }) }),
					}),
				}),
			});
		},
	} as unknown as Db;
	const { send } = refreshEndpoint();

	const { data, error } = await ensureAccessToken({
		db,
		cipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'missing',
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('ConnectionNotFound');
});

test('a row encrypted under an older key version is re-encrypted forward on next use', async () => {
	// Written before the rotation, under v1.
	const { data: v1Cipher } = await createTokenCipher([
		{ version: 1, base64Key: KEY },
	]);
	const row = await buildRow(v1Cipher as TokenCipher, {
		// Still fresh in time, so only the key version can trigger the rewrite.
		accessExpiresInMs: 60 * 60 * 1000,
	});
	expect(row.accessTokenCiphertext).toStartWith('v1.');

	const v2Key = Buffer.from(new Uint8Array(32).fill(4)).toString('base64url');
	const { data: rotated } = await createTokenCipher([
		{ version: 1, base64Key: KEY },
		{ version: 2, base64Key: v2Key },
	]);
	const { db, state } = fakeDb(row);
	const { send, seen } = refreshEndpoint();

	const { error } = await ensureAccessToken({
		db,
		cipher: rotated as TokenCipher,
		oauth: createTikTokOAuthClient({
			clientKey: 'ck',
			clientSecret: 'cs',
			fetch: send,
		}),
		connectionId: 'conn-1',
	});

	expect(error).toBeNull();
	// The refresh is what carries the row forward onto the current key.
	expect(seen).toEqual(['rft.stored']);
	expect(state.row.accessTokenCiphertext).toStartWith('v2.');
	expect(state.row.refreshTokenCiphertext).toStartWith('v2.');
});
