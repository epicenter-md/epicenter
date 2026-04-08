/**
 * parseMarkdownFile Tests
 *
 * Verifies YAML frontmatter parsing from markdown strings: splitting
 * the `---` delimited frontmatter from the body, handling edge cases
 * like missing delimiters, null values, and empty bodies.
 *
 * Key behaviors:
 * - Standard frontmatter + body splits correctly
 * - Frontmatter-only files (no body) return undefined body
 * - Files without `---` delimiter return null
 * - Unclosed frontmatter returns null
 * - YAML null values are preserved (not stripped)
 */
import { describe, expect, test } from 'bun:test';
import { parseMarkdownFile } from './parse-markdown-file';

describe('parseMarkdownFile', () => {
	test('parses frontmatter and body from standard format', () => {
		const content = '---\nid: abc\ntitle: Hello\n---\n\nSome body content\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc', title: 'Hello' });
		expect(result!.body).toBe('Some body content');
	});

	test('parses frontmatter-only file (no body)', () => {
		const content = '---\nid: abc\ntitle: Hello\n---\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc', title: 'Hello' });
		expect(result!.body).toBeUndefined();
	});

	test('returns null for files without frontmatter', () => {
		const content = '# Just a heading\n\nSome content\n';
		expect(parseMarkdownFile(content)).toBeNull();
	});

	test('returns null for files with unclosed frontmatter', () => {
		const content = '---\nid: abc\ntitle: Hello\n';
		expect(parseMarkdownFile(content)).toBeNull();
	});

	test('preserves null values in frontmatter', () => {
		const content = '---\nid: abc\ntrashedAt: null\n---\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter.trashedAt).toBeNull();
	});

	test('returns null for empty string', () => {
		expect(parseMarkdownFile('')).toBeNull();
	});

	test('handles multiline body content', () => {
		const content =
			'---\nid: abc\n---\n\n# Heading\n\nParagraph one.\n\nParagraph two.\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.body).toBe('# Heading\n\nParagraph one.\n\nParagraph two.');
	});

	test('handles CRLF line endings', () => {
		const content =
			'---\r\nid: abc\r\ntitle: Hello\r\n---\r\n\r\nSome body content\r\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc', title: 'Hello' });
		expect(result!.body).toBe('Some body content');
	});

	test('does not match closing delimiter followed by text', () => {
		const content = '---\nid: abc\n---extra\n\nBody\n';
		expect(parseMarkdownFile(content)).toBeNull();
	});

	test('handles closing delimiter at EOF without trailing newline', () => {
		const content = '---\nid: abc\ntitle: Hello\n---';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc', title: 'Hello' });
		expect(result!.body).toBeUndefined();
	});

	test('body can contain --- on a line', () => {
		const content = '---\nid: abc\n---\n\nSome text\n---\nMore text\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc' });
		expect(result!.body).toBe('Some text\n---\nMore text');
	});

	test('handles body immediately after closing delimiter (no blank separator)', () => {
		const content = '---\nid: abc\n---\nBody immediately\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc' });
		expect(result!.body).toBe('Body immediately');
	});

	test('returns undefined body when only whitespace/newlines follow frontmatter', () => {
		const content = '---\nid: abc\n---\n\n\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc' });
		expect(result!.body).toBeUndefined();
	});

	test('strips UTF-8 BOM before parsing', () => {
		const content =
			'\uFEFF---\nid: abc\ntitle: Hello\n---\n\nSome body content\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc', title: 'Hello' });
		expect(result!.body).toBe('Some body content');
	});

	test('tolerates trailing whitespace on delimiter lines', () => {
		const content = '---   \nid: abc\n---\t \n\nBody\n';
		const result = parseMarkdownFile(content);
		expect(result).not.toBeNull();
		expect(result!.frontmatter).toEqual({ id: 'abc' });
		expect(result!.body).toBe('Body');
	});

	test('returns null for comment-only frontmatter', () => {
		const content = '---\n# this is a comment\n---\n';
		expect(parseMarkdownFile(content)).toBeNull();
	});
});
