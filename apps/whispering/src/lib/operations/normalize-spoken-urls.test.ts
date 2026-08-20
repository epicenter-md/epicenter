/**
 * Spoken Technical Text Normalization Tests
 *
 * Verifies the deterministic, on-device rewrite of explicitly dictated URLs.
 * The normalizer must recognize URL punctuation without treating ordinary words
 * such as "dot" and "slash" as commands outside a URL-shaped phrase.
 *
 * Key behaviors:
 * - Spoken protocol and domain punctuation becomes a usable URL
 * - URL ports and paths are normalized without swallowing following prose
 * - Ordinary prose remains unchanged
 */
import { expect, test } from 'bun:test';
import { normalizeSpokenUrls } from './normalize-spoken-urls';

test('spoken HTTPS punctuation becomes a URL', () => {
	expect(normalizeSpokenUrls('HTTPS colon slash slash foo dot com')).toBe(
		'https://foo.com',
	);
});

test('natural ASR shorthand becomes a URL without swallowing following prose', () => {
	expect(
		normalizeSpokenUrls(
			'Alright, say http s, slash, food.com slash and it should work.',
		),
	).toBe('Alright, say https://food.com/ and it should work.');
});

test('forward slash, domain hyphens, ports, and paths are normalized', () => {
	expect(
		normalizeSpokenUrls(
			'Open HTTP colon forward slash forward slash my hyphen site dot example dot com colon 8080 slash API hyphen docs slash v1 please.',
		),
	).toBe('Open http://my-site.example.com:8080/API-docs/v1 please.');
});

test('path underscores preserve path casing', () => {
	expect(
		normalizeSpokenUrls(
			'HTTP colon slash slash example dot com slash User underscore Profile',
		),
	).toBe('http://example.com/User_Profile');
});

test('URL normalization stops before following prose', () => {
	expect(
		normalizeSpokenUrls(
			'Visit HTTPS colon slash slash docs dot example dot com and sign in.',
		),
	).toBe('Visit https://docs.example.com and sign in.');
});

test('ordinary uses of dot and slash remain literal', () => {
	expect(
		normalizeSpokenUrls('Connect the dots, then describe the slash command.'),
	).toBe('Connect the dots, then describe the slash command.');
	expect(normalizeSpokenUrls('example dot com slash docs')).toBe(
		'example dot com slash docs',
	);
});
