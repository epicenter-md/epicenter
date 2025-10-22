import { describe, it } from 'bun:test'; // Run with: node --test dist/... after build
import assert from 'node:assert/strict';
import { Markdown } from './index';

describe('Markdown.parse', () => {
	it('parses body without frontmatter gracefully', () => {
		const input = 'Hello world';
		const result = Markdown.parse(input);
		assert.deepEqual(result, { body: 'Hello world', frontmatter: {} });
	});

	it('parses YAML frontmatter and body', () => {
		const input =
			'---\n' +
			'title: Test Doc\n' +
			'draft: true\n' +
			'---\n\n' +
			'Content here.';
		const result = Markdown.parse(input);
		assert.equal(result.body.trim(), 'Content here.');
		assert.deepEqual(result.frontmatter, { title: 'Test Doc', draft: true });
	});
});

describe('Markdown.stringify', () => {
	it('stringifies with frontmatter', () => {
		const obj = {
			body: 'Content here.',
			frontmatter: { title: 'Test Doc', draft: true },
		};
		const md = Markdown.stringify(obj);
		assert.match(md, /---/);
		assert.match(md, /title: Test Doc/);
		assert.match(md, /draft: true/);
		assert.match(md, /Content here\./);
	});

	it('stringifies without frontmatter', () => {
		const obj = { body: 'Just content', frontmatter: {} };
		const md = Markdown.stringify(obj);
		assert.equal(md, 'Just content');
	});

	it('roundtrips frontmatter + body', () => {
		const original = { body: 'Body text', frontmatter: { a: 1 } };
		const md = Markdown.stringify(original);
		const parsed = Markdown.parse(md);
		assert.deepEqual(parsed.frontmatter, { a: 1 });
		assert.equal(parsed.body.trim(), 'Body text');
	});
});
