/**
 * The Mail window's one native grant, checked against the URL it exists for.
 *
 * The grant is a glob in a JSON capability file and the endpoint is a constant
 * in another package, so nothing but this test connects them. Tauri denies
 * `open_url` for any URL outside the scope, and it denies it at runtime with no
 * build-time complaint, so the failure this catches is a Connect button that
 * silently stops working: Google moves the endpoint, or somebody tightens the
 * scope, and the two drift apart with every other suite still green.
 *
 * Scope entries are matched with Rust's `glob` crate, whose default
 * `require_literal_separator: false` lets `*` cross `/`. That is why one
 * trailing `*` covers the whole authorization path and its query. This test
 * does not re-implement that matcher; it pins the pattern to origin-plus-one-
 * wildcard, which is the only shape where a prefix check and the glob agree.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOOGLE_AUTHORIZE_URL } from '@epicenter/local-mail/config';

const CAPABILITIES = join(
	fileURLToPath(new URL('.', import.meta.url)),
	'..',
	'src-tauri',
	'capabilities',
);

const FILES = [
	'mail-gmail-authorization-development.json',
	'mail-gmail-authorization-production.json',
];

/** The one URL pattern a capability's `opener:allow-open-url` grant admits. */
function openablePattern(file: string): string {
	const capability = JSON.parse(
		readFileSync(join(CAPABILITIES, file), 'utf8'),
	) as {
		permissions: ({ identifier: string; allow: { url: string }[] } | string)[];
	};
	const grant = capability.permissions.find(
		(permission) =>
			typeof permission === 'object' &&
			permission.identifier === 'opener:allow-open-url',
	);
	if (typeof grant !== 'object') {
		throw new Error(`${file} grants no opener:allow-open-url`);
	}
	expect(grant.allow).toHaveLength(1);
	return grant.allow[0]?.url ?? '';
}

describe("the Mail window's Gmail consent grant", () => {
	test('admits the authorization endpoint Local Mail actually builds', () => {
		for (const file of FILES) {
			const pattern = openablePattern(file);
			// Origin, then one wildcard, then nothing: no interior `*` that a
			// crafted host or path could satisfy.
			expect(pattern).toBe('https://accounts.google.com/*');
			expect(GOOGLE_AUTHORIZE_URL.startsWith(pattern.slice(0, -1))).toBe(true);
		}
	});

	test('admits nothing else, so this is not a general power to open links', () => {
		for (const file of FILES) {
			const origin = openablePattern(file).slice(0, -1);
			for (const denied of [
				'https://accounts.google.com.evil.test/o/oauth2/v2/auth',
				'https://evil.test/?u=https://accounts.google.com/',
				'http://accounts.google.com/o/oauth2/v2/auth',
				'file:///etc/passwd',
			]) {
				expect(denied.startsWith(origin)).toBe(false);
			}
		}
	});
});
