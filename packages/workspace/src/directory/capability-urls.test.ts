/**
 * capabilityUrls Tests
 *
 * The box surface is one origin with fixed path suffixes (`/mcp`, `/v1`). These
 * tests pin the derivation to be pure and trailing-slash-stable, so a stored
 * `baseUrl` with or without a trailing slash derives identical surfaces and the
 * two suffixes can never land on different hosts.
 */

import { describe, expect, test } from 'bun:test';
import { capabilityUrls } from './capability-urls.js';

describe('capabilityUrls', () => {
	test('derives /mcp and /v1 from a clean origin', () => {
		expect(capabilityUrls('https://mac-studio.tail1234.ts.net')).toEqual({
			mcp: 'https://mac-studio.tail1234.ts.net/mcp',
			v1: 'https://mac-studio.tail1234.ts.net/v1',
		});
	});

	test('strips a single trailing slash', () => {
		expect(capabilityUrls('https://box.ts.net/')).toEqual({
			mcp: 'https://box.ts.net/mcp',
			v1: 'https://box.ts.net/v1',
		});
	});

	test('strips multiple trailing slashes', () => {
		expect(capabilityUrls('https://box.ts.net///')).toEqual({
			mcp: 'https://box.ts.net/mcp',
			v1: 'https://box.ts.net/v1',
		});
	});

	test('appends under an existing base path', () => {
		expect(capabilityUrls('https://box.ts.net/books')).toEqual({
			mcp: 'https://box.ts.net/books/mcp',
			v1: 'https://box.ts.net/books/v1',
		});
	});

	test('is pure: same input yields equal output and does not mutate the argument', () => {
		const base = 'https://box.ts.net/';
		const first = capabilityUrls(base);
		const second = capabilityUrls(base);
		expect(first).toEqual(second);
		expect(base).toBe('https://box.ts.net/');
	});
});
