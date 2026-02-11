import { afterEach, describe, expect, test } from 'bun:test';
import { formatJson, formatJsonl, output } from './format-output.js';

describe('formatJson', () => {
	const originalIsTTY = process.stdout.isTTY;

	afterEach(() => {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: originalIsTTY,
			writable: true,
			configurable: true,
		});
	});

	test('pretty-prints when TTY', () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: true,
			writable: true,
			configurable: true,
		});
		const data = { name: 'test', value: 42 };
		const result = formatJson(data);
		expect(result).toBe('{\n  "name": "test",\n  "value": 42\n}');
	});

	test('compacts when not TTY', () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: false,
			writable: true,
			configurable: true,
		});
		const data = { name: 'test', value: 42 };
		const result = formatJson(data);
		expect(result).toBe('{"name":"test","value":42}');
	});

	test('compacts when format is jsonl regardless of TTY', () => {
		Object.defineProperty(process.stdout, 'isTTY', {
			value: true,
			writable: true,
			configurable: true,
		});
		const data = { name: 'test' };
		const result = formatJson(data, { format: 'jsonl' });
		expect(result).toBe('{"name":"test"}');
	});
});

describe('formatJsonl', () => {
	test('outputs one object per line', () => {
		const values = [
			{ id: 1, name: 'first' },
			{ id: 2, name: 'second' },
			{ id: 3, name: 'third' },
		];
		const result = formatJsonl(values);
		expect(result).toBe(
			'{"id":1,"name":"first"}\n{"id":2,"name":"second"}\n{"id":3,"name":"third"}',
		);
	});

	test('handles empty array', () => {
		const result = formatJsonl([]);
		expect(result).toBe('');
	});

	test('handles single item', () => {
		const result = formatJsonl([{ value: 'single' }]);
		expect(result).toBe('{"value":"single"}');
	});

	test('handles mixed types', () => {
		const values = [{ a: 1 }, 'string', 42, null, [1, 2, 3]];
		const result = formatJsonl(values);
		expect(result).toBe('{"a":1}\n"string"\n42\nnull\n[1,2,3]');
	});
});

describe('output', () => {
	test('throws error when format is jsonl but value is not array', () => {
		expect(() => output({ notAnArray: true }, { format: 'jsonl' })).toThrow(
			'JSONL format requires an array value',
		);
	});
});
