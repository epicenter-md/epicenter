import { expect, test } from 'bun:test';
import { resolveTikTokConfig, tiktokRedirectUri } from './config.js';

function keyOf(fill: number): string {
	return Buffer.from(new Uint8Array(32).fill(fill)).toString('base64url');
}

const BASE = {
	TIKTOK_CLIENT_KEY: 'ck',
	TIKTOK_CLIENT_SECRET: 'cs',
	TIKTOK_TOKEN_ENCRYPTION_KEY: keyOf(1),
};

test('the redirect URI is derived from the deployment origin, not hardcoded', () => {
	expect(tiktokRedirectUri('https://api.epicenter.so')).toBe(
		'https://api.epicenter.so/api/integrations/tiktok/callback',
	);
	expect(tiktokRedirectUri('http://localhost:8787')).toBe(
		'http://localhost:8787/api/integrations/tiktok/callback',
	);
});

test('an unconfigured deployment names exactly what is missing', async () => {
	const { data, error } = await resolveTikTokConfig({});

	expect(data).toBeNull();
	expect(error?.name).toBe('NotConfigured');
	expect(error).toMatchObject({
		missing: [
			'TIKTOK_CLIENT_KEY',
			'TIKTOK_CLIENT_SECRET',
			'TIKTOK_TOKEN_ENCRYPTION_KEY',
		],
	});
});

test('with only the primary key, ciphertext is written at version 1', async () => {
	const { data } = await resolveTikTokConfig(BASE);

	expect(data?.cipher.activeVersion).toBe(1);
});

test('non-string Worker bindings are ignored while discovering rotation keys', async () => {
	const { data, error } = await resolveTikTokConfig({
		...BASE,
		ROOM: { idFromName: () => null },
		ASSETS: { fetch: () => new Response() },
	} as Parameters<typeof resolveTikTokConfig>[0]);

	expect(error).toBeNull();
	expect(data?.cipher.activeVersion).toBe(1);
});

test('rotation is open-ended: a _V3 binding becomes the active version', async () => {
	// The wall this guards against: hardcoding "the rotation key is v2" means a
	// SECOND rotation has nowhere to go, and reusing the V2 binding would make
	// every existing v2 envelope fail to decrypt, forcing a mass reconnect.
	const { data, error } = await resolveTikTokConfig({
		...BASE,
		TIKTOK_TOKEN_ENCRYPTION_KEY_V2: keyOf(2),
		TIKTOK_TOKEN_ENCRYPTION_KEY_V3: keyOf(3),
	} as Parameters<typeof resolveTikTokConfig>[0]);

	expect(error).toBeNull();
	expect(data?.cipher.activeVersion).toBe(3);

	// Every older version stays readable, so no rotation strands a connection.
	const { data: v3Envelope } = await (
		data as NonNullable<typeof data>
	).cipher.encrypt('token');
	expect(v3Envelope).toStartWith('v3.');

	const onlyV2 = await resolveTikTokConfig({
		...BASE,
		TIKTOK_TOKEN_ENCRYPTION_KEY_V2: keyOf(2),
	} as Parameters<typeof resolveTikTokConfig>[0]);
	const { data: v2Envelope } = await (
		onlyV2.data as NonNullable<typeof onlyV2.data>
	).cipher.encrypt('token');
	expect(v2Envelope).toStartWith('v2.');
	// The v3 deployment can still read what the v2 deployment wrote.
	const { data: plaintext } = await (
		data as NonNullable<typeof data>
	).cipher.decrypt(v2Envelope as string);
	expect(plaintext).toBe('token');
});

test('a malformed rotation key fails configuration instead of being skipped', async () => {
	const { data, error } = await resolveTikTokConfig({
		...BASE,
		TIKTOK_TOKEN_ENCRYPTION_KEY_V2: 'not-32-bytes',
	} as Parameters<typeof resolveTikTokConfig>[0]);

	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidKeyMaterial');
});
