import { describe, it } from 'bun:test'; // Run with: node --test dist/... after build
import assert from 'node:assert/strict';
import { JSONL } from './index';

describe('JSONL.parse', () => {
	it('parses multiple lines into objects', () => {
		const input = '{"a":1}\n{"b":2}\n';
		const result = JSONL.parse(input);
		assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
	});

	it('returns empty array for blank input', () => {
		const result = JSONL.parse('   ');
		assert.deepEqual(result, []);
	});

	it('throws with line number on invalid JSON', () => {
		const input = '{"a":1}\n{"b":}\n{"c":3}';
		try {
			JSONL.parse(input);
			assert.fail('Expected error');
		} catch (e) {
			assert.ok(e instanceof Error);
			assert.match(e.message, /Invalid JSONL at line 2/);
		}
	});
});

describe('JSONL.stringify', () => {
	it('stringifies array of objects to JSONL', () => {
		const arr = [{ a: 1 }, { b: 2 }];
		const text = JSONL.stringify(arr);
		assert.equal(text, '{"a":1}\n{"b":2}');
	});

	it('throws on empty array', () => {
		assert.throws(() => JSONL.stringify([]), /non-empty array/);
	});
});
