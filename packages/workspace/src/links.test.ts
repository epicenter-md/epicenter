import { describe, expect, test } from 'bun:test';
import {
	convertEpicenterLinksToWikilinks,
	convertWikilinksToEpicenterLinks,
	EPICENTER_LINK_RE,
	isEpicenterLink,
	makeEpicenterLink,
	parseEpicenterLink,
} from './links.js';

const SAMPLE_ID = '01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b';
const SAMPLE_WORKSPACE = 'honeycrisp';
const SAMPLE_TABLE = 'notes';
const SAMPLE_REF = `epicenter://honeycrisp/notes/${SAMPLE_ID}`;

describe('isEpicenterLink', () => {
	test('returns true for epicenter URIs', () => {
		expect(isEpicenterLink(SAMPLE_REF)).toBe(true);
	});

	test('returns false for https URLs', () => {
		expect(isEpicenterLink('https://example.com')).toBe(false);
	});

	test('returns false for bare ids', () => {
		expect(isEpicenterLink(SAMPLE_ID)).toBe(false);
	});
});

describe('parseEpicenterLink', () => {
	test('extracts workspace, table, and id', () => {
		expect(parseEpicenterLink(SAMPLE_REF)).toEqual({
			workspace: SAMPLE_WORKSPACE,
			table: SAMPLE_TABLE,
			id: SAMPLE_ID,
		});
	});

	test('returns null for non-epicenter URIs', () => {
		expect(parseEpicenterLink('https://example.com/files/abc')).toBeNull();
	});

	test('handles dots in workspace ids', () => {
		expect(parseEpicenterLink('epicenter://epicenter.blog/posts/abc')).toEqual({
			workspace: 'epicenter.blog',
			table: 'posts',
			id: 'abc',
		});
	});
});

describe('makeEpicenterLink', () => {
	test('produces the correct URI', () => {
		expect(makeEpicenterLink(SAMPLE_WORKSPACE, SAMPLE_TABLE, SAMPLE_ID)).toBe(
			SAMPLE_REF,
		);
	});
});

describe('convertEpicenterLinksToWikilinks', () => {
	test('converts epicenter links to wikilinks', () => {
		const body = `See [Meeting Notes](${SAMPLE_REF}) for details.`;

		expect(convertEpicenterLinksToWikilinks(body)).toBe(
			'See [[Meeting Notes]] for details.',
		);
	});

	test('leaves external links untouched', () => {
		const body = '[Google](https://google.com)';

		expect(convertEpicenterLinksToWikilinks(body)).toBe(body);
	});

	test('handles mixed epicenter links and external links', () => {
		const body = `[Notes](${SAMPLE_REF}) and [Google](https://google.com)`;

		expect(convertEpicenterLinksToWikilinks(body)).toBe(
			'[[Notes]] and [Google](https://google.com)',
		);
	});
});

describe('convertWikilinksToEpicenterLinks', () => {
	const resolve = (name: string) => {
		const lookup: Record<string, string> = {
			'First Note': SAMPLE_REF,
			'Project Plan': 'epicenter://honeycrisp/notes/def-456',
		};

		return lookup[name] ?? null;
	};

	test('converts wikilinks to epicenter links', () => {
		const body = 'See [[First Note]] for details.';

		expect(convertWikilinksToEpicenterLinks(body, resolve)).toBe(
			`See [First Note](${SAMPLE_REF}) for details.`,
		);
	});

	test('leaves unresolved wikilinks as-is', () => {
		const body = '[[Unknown Page]]';

		expect(convertWikilinksToEpicenterLinks(body, resolve)).toBe(body);
	});
});

describe('EPICENTER_LINK_RE', () => {
	test('matches markdown epicenter link links with both capture groups', () => {
		const body = `See [First Note](${SAMPLE_REF}) for details.`;
		EPICENTER_LINK_RE.lastIndex = 0;
		const match = EPICENTER_LINK_RE.exec(body);

		expect(match?.[0]).toBe(`[First Note](${SAMPLE_REF})`);
		expect(match?.[1]).toBe('First Note');
		expect(match?.[2]).toBe(SAMPLE_REF);

		EPICENTER_LINK_RE.lastIndex = 0;
	});

	test('does not match external links', () => {
		EPICENTER_LINK_RE.lastIndex = 0;
		const match = EPICENTER_LINK_RE.exec('[First Note](https://example.com)');

		expect(match).toBeNull();
		EPICENTER_LINK_RE.lastIndex = 0;
	});
});
