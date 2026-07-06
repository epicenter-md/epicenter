import { expect, test } from 'bun:test';
import { resolveGmailCredentials } from './gmail-credentials.ts';

/**
 * The Gmail credential resolver reads the single BYO Local Mail OAuth keyset.
 * Every case injects a `read` source instead of touching `process.env`, so the
 * tests are hermetic and order-independent.
 */

/** Read from a fixed map instead of process.env. */
const readFrom =
	(map: Record<string, string>) =>
	(name: string): string | undefined =>
		map[name];

test('resolveGmailCredentials reads the BYO Gmail keyset', () => {
	expect(
		resolveGmailCredentials(
			readFrom({
				GMAIL_CLIENT_ID: 'client-id',
				GMAIL_CLIENT_SECRET: 'client-secret',
			}),
		),
	).toEqual({
		clientId: 'client-id',
		clientSecret: 'client-secret',
	});
});

test('resolveGmailCredentials names missing variables', () => {
	expect(() => resolveGmailCredentials(readFrom({}))).toThrow(
		'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET',
	);
	expect(() =>
		resolveGmailCredentials(readFrom({ GMAIL_CLIENT_ID: 'client-id' })),
	).toThrow('GMAIL_CLIENT_SECRET');
});
