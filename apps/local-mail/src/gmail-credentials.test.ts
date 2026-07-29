import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	persistGmailProviderCredentials,
	resolveGmailCredentials,
} from './gmail-credentials.ts';

/**
 * Every case injects fixed sources instead of touching `process.env`, so the
 * tests are hermetic and order-independent.
 */

/** Read from a fixed map instead of process.env. */
const readFrom =
	(map: Record<string, string>) =>
	(name: string): string | undefined =>
		map[name];

test('resolveGmailCredentials reads the machine-wide override', () => {
	expect(
		resolveGmailCredentials(
			readFrom({
				GMAIL_CLIENT_ID: 'client-id',
				GMAIL_CLIENT_SECRET: 'client-secret',
			}),
			readFrom({}),
		),
	).toEqual({
		clientId: 'client-id',
		clientSecret: 'client-secret',
		source: 'override',
	});
});

test('resolveGmailCredentials falls back to the distribution identity', () => {
	expect(
		resolveGmailCredentials(
			readFrom({}),
			readFrom({
				LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID: 'distribution-id',
				LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET: 'distribution-secret',
			}),
		),
	).toEqual({
		clientId: 'distribution-id',
		clientSecret: 'distribution-secret',
		source: 'distribution',
	});
});

test('resolveGmailCredentials keeps a partial override atomic', () => {
	expect(() =>
		resolveGmailCredentials(
			readFrom({ GMAIL_CLIENT_ID: 'client-id' }),
			readFrom({
				LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_ID: 'distribution-id',
				LOCAL_MAIL_DISTRIBUTION_GMAIL_CLIENT_SECRET: 'distribution-secret',
			}),
		),
	).toThrow('GMAIL_CLIENT_SECRET');
});

test('resolveGmailCredentials names the public BYO fields when no identity exists', () => {
	expect(() => resolveGmailCredentials(readFrom({}), readFrom({}))).toThrow(
		'GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET',
	);
});

test('persistGmailProviderCredentials stores only an explicit override', () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'local-mail-gmail-identity-'));
	const path = join(dataDir, 'provider.json');

	try {
		persistGmailProviderCredentials(dataDir, {
			clientId: 'distribution-id',
			clientSecret: 'distribution-secret',
			source: 'distribution',
		});
		expect(existsSync(path)).toBe(false);

		persistGmailProviderCredentials(dataDir, {
			clientId: 'override-id',
			clientSecret: 'override-secret',
			source: 'override',
		});
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
			GMAIL_CLIENT_ID: 'override-id',
			GMAIL_CLIENT_SECRET: 'override-secret',
		});
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
