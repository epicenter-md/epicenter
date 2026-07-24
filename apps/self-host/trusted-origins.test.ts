/**
 * The self-host CORS trust set.
 *
 * This function IS the instance's cross-origin security boundary, so the tests
 * that matter are the refusals: anything accepted here can read authenticated
 * responses from the instance in a browser. `TRUSTED_BROWSER_ORIGINS` therefore
 * takes exact origins only, spelled the way a browser spells the `Origin`
 * header, and every near-miss is a boot failure rather than a quiet widening.
 */

import { expect, test } from 'bun:test';

import { resolveSelfHostTrustedOrigins } from './trusted-origins.js';

test('trusts the instance, Tauri, and exact configured browser origins', () => {
	expect(
		resolveSelfHostTrustedOrigins(
			'https://instance.example.com/api',
			'https://notes.example.com, http://localhost:5176',
		),
	).toEqual([
		'https://instance.example.com',
		'tauri://localhost',
		'https://notes.example.com',
		'http://localhost:5176',
	]);
});

test('no configuration means no extra cross-origin browser trust', () => {
	const bare = ['https://instance.example.com', 'tauri://localhost'];
	expect(resolveSelfHostTrustedOrigins('https://instance.example.com')).toEqual(
		bare,
	);
	expect(
		resolveSelfHostTrustedOrigins('https://instance.example.com', ''),
	).toEqual(bare);
	expect(
		resolveSelfHostTrustedOrigins('https://instance.example.com', ' , ,'),
	).toEqual(bare);
});

test('repeating the instance or an entry does not repeat it in the set', () => {
	expect(
		resolveSelfHostTrustedOrigins(
			'https://instance.example.com',
			'https://instance.example.com, https://notes.example.com, https://notes.example.com',
		),
	).toEqual([
		'https://instance.example.com',
		'tauri://localhost',
		'https://notes.example.com',
	]);
});

// Each of these is a distinct way an operator could widen browser trust past
// what they intended, so each one must fail loudly with the same message.
const REFUSED: [label: string, value: string][] = [
	['a wildcard', '*'],
	// A valid URL whose origin round-trips, so only the scheme/host rule stops
	// it. Without that rule this is accepted and then never matches anything.
	['a wildcard subdomain', 'https://*.example.com'],
	['a non-browser scheme', 'ws://notes.example.com'],
	['a path', 'https://notes.example.com/app'],
	['a trailing slash', 'https://notes.example.com/'],
	['a query', 'https://notes.example.com?x=1'],
	['a fragment', 'https://notes.example.com#x'],
	['embedded credentials', 'https://user:pass@notes.example.com'],
	['an explicit default port', 'https://notes.example.com:443'],
	['an uppercase spelling', 'HTTPS://Notes.Example.com'],
	['an opaque origin', 'file:///etc/passwd'],
	['a bare host with no scheme', 'notes.example.com'],
	['the literal null origin', 'null'],
];

for (const [label, value] of REFUSED) {
	test(`refuses ${label}`, () => {
		expect(() =>
			resolveSelfHostTrustedOrigins('https://instance.example.com', value),
		).toThrow(
			`TRUSTED_BROWSER_ORIGINS must contain exact origins, received '${value}'`,
		);
	});
}

test('one bad entry refuses the whole set rather than trusting the rest', () => {
	expect(() =>
		resolveSelfHostTrustedOrigins(
			'https://instance.example.com',
			'https://notes.example.com, https://notes.example.com/app',
		),
	).toThrow('must contain exact origins');
});
