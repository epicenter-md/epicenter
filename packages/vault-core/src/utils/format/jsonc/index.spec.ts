import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { JSONC } from './index';

describe('JSONC.parse', () => {
	it('parses object with single-line comments', () => {
		const input = `{
      // comment about a
      "a": 1,
      "b": 2 // trailing comment
    }`;
		const result = JSONC.parse(input);
		assert.deepEqual(result, { a: 1, b: 2 });
	});

	it('parses object with multi-line comments and trailing commas', () => {
		const input = `{
      /* block comment */
      "a": 1,
      "b": 2,
    }`;
		const result = JSONC.parse(input);
		assert.deepEqual(result, { a: 1, b: 2 });
	});

	it('applies reviver function', () => {
		const input = '{"a":1,"b":2}';
		const result = JSONC.parse(input, (_, v) =>
			typeof v === 'number' ? v * 10 : v,
		);
		assert.deepEqual(result, { a: 10, b: 20 });
	});
});

describe('JSONC.stringify', () => {
	it('stringifies object using JSON.stringify behavior', () => {
		const obj = { a: 1, b: 'x' };
		const text = JSONC.stringify(obj);
		assert.equal(text, JSON.stringify(obj));
	});

	it('supports replacer and space parameters', () => {
		const obj = { a: 1, b: 2 };
		const text = JSONC.stringify(obj, (k, v) => (k === 'b' ? undefined : v), 2);
		assert.equal(text, JSON.stringify({ a: 1 }, null, 2));
	});
});
