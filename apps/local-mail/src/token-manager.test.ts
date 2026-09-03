/**
 * The live-token manager between Gmail callers and the secret store.
 *
 * What is pinned here: a held access token is used without touching the token
 * endpoint, an expired one refreshes once and stores back whatever refresh
 * token is now current, concurrent callers share one grant, a failed grant does
 * not poison the next call, and a device holding no credential says so in the
 * words a person can act on.
 */

import { expect, test } from 'bun:test';
import { type SecretStore, secretLabel } from '@epicenter/app';
import { Ok } from 'wellcrafted/result';
import { DEFAULT_MAIL_CONFIG, type MailConfig } from './config.ts';
import { createTokenManager } from './token-manager.ts';

const IDENTITY = { clientId: 'client-id-123', clientSecret: 'client-secret' };
const ACCOUNT = secretLabel('account-row-id');
const NOW = () => Date.parse('2026-07-01T00:00:00.000Z');

function config(overrides: Partial<MailConfig> = {}): MailConfig {
	return { ...DEFAULT_MAIL_CONFIG, ...overrides };
}

function secretStore(initial: string | null = 'old-refresh-token') {
	const writes: string[] = [];
	let held = initial;
	const secrets: SecretStore = {
		async get() {
			return Ok(held);
		},
		async put(_accountId, value) {
			held = value;
			writes.push(value);
			return Ok(undefined);
		},
		async delete() {
			held = null;
			return Ok(undefined);
		},
	};
	return { secrets, writes };
}

function tokenServer(
	handler: (request: Request) => Response | Promise<Response>,
) {
	return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
}

test('a held access token is used without touching the token endpoint', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		return Response.json({
			token_type: 'Bearer',
			access_token: 'first-access-token',
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	expect((await manager.getValidAccessToken()).data).toBe('first-access-token');
	expect((await manager.getValidAccessToken()).data).toBe('first-access-token');
	expect(requests).toBe(1);
	// Google returned no rotated token, so nothing was written back.
	expect(writes).toEqual([]);
	server.stop(true);
});

test('a rotated refresh token is stored back', async () => {
	const bodies: URLSearchParams[] = [];
	const server = tokenServer(async (request) => {
		bodies.push(new URLSearchParams(await request.text()));
		return Response.json({
			token_type: 'Bearer',
			access_token: 'new-access-token',
			refresh_token: 'new-refresh-token',
			expires_in: 3600,
		});
	});
	const { secrets, writes } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const { data, error } = await manager.getValidAccessToken();
	expect(error).toBeNull();
	expect(data).toBe('new-access-token');
	expect(bodies[0]?.get('grant_type')).toBe('refresh_token');
	expect(bodies[0]?.get('refresh_token')).toBe('old-refresh-token');
	expect(writes).toEqual(['new-refresh-token']);
	server.stop(true);
});

test('concurrent callers share one refresh grant', async () => {
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const server = tokenServer(async () => {
		requests += 1;
		await release.promise;
		return Response.json({
			token_type: 'Bearer',
			access_token: 'shared-access-token',
			expires_in: 3600,
		});
	});
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const first = manager.getValidAccessToken();
	const second = manager.getValidAccessToken();
	while (requests === 0) await Bun.sleep(1);
	release.resolve();
	const [one, two] = await Promise.all([first, second]);

	expect(one.data).toBe('shared-access-token');
	expect(two.data).toBe('shared-access-token');
	expect(requests).toBe(1);
	server.stop(true);
});

test('a failed grant does not poison the next call', async () => {
	let requests = 0;
	const server = tokenServer(() => {
		requests += 1;
		if (requests === 1) {
			return Response.json(
				{
					error: 'invalid_client',
					error_description: 'The OAuth client was not found.',
				},
				{ status: 401 },
			);
		}
		return Response.json({
			token_type: 'Bearer',
			access_token: 'retried-access-token',
			expires_in: 3600,
		});
	});
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const failed = await manager.getValidAccessToken();
	const retried = await manager.getValidAccessToken();

	expect(failed.error?.name).toBe('TokenExchangeFailed');
	expect(retried.data).toBe('retried-access-token');
	expect(requests).toBe(2);
	server.stop(true);
});

test('a revoked grant asks for re-consent rather than a retry', async () => {
	const server = tokenServer(() =>
		Response.json(
			{ error: 'invalid_grant', error_description: 'Token revoked.' },
			{ status: 400 },
		),
	);
	const { secrets } = secretStore();
	const manager = createTokenManager({
		config: config({ tokenUrl: `http://127.0.0.1:${server.port}/token` }),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	expect((await manager.getValidAccessToken()).error?.name).toBe(
		'ReauthRequired',
	);
	server.stop(true);
});

test('a device holding no credential asks for the account again', async () => {
	// The account list synchronized and the credential did not, which is what a
	// browser reload and a new desktop device both look like (ADR-0310).
	const { secrets } = secretStore(null);
	const manager = createTokenManager({
		config: config(),
		identity: IDENTITY,
		secrets,
		label: ACCOUNT,
		now: NOW,
	});

	const result = await manager.getValidAccessToken();
	expect(result.error?.name).toBe('ReauthRequired');
	expect(result.error?.message).toContain('holds no credential');
});
