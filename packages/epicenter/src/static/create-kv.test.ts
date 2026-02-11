import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createKv } from './create-kv.js';
import { defineKv } from './define-kv.js';

describe('createKv', () => {
	test('set and get a value', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" })),
		});

		kv.set('theme', { mode: 'dark' });

		const result = kv.get('theme');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.value).toEqual({ mode: 'dark' });
		}
	});

	test('get returns not_found for unset key', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" })),
		});

		const result = kv.get('theme');
		expect(result.status).toBe('not_found');
	});

	test('delete removes the value', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv(type({ mode: "'light' | 'dark'" })),
		});

		kv.set('theme', { mode: 'dark' });
		expect(kv.get('theme').status).toBe('valid');

		kv.delete('theme');
		expect(kv.get('theme').status).toBe('not_found');
	});

	test('migrates old data on read', () => {
		const ydoc = new Y.Doc();
		const kv = createKv(ydoc, {
			theme: defineKv()
				.version(type({ mode: "'light' | 'dark'" }))
				.version(type({ mode: "'light' | 'dark'", fontSize: 'number' }))
				.migrate((v) => {
					if (!('fontSize' in v)) return { ...v, fontSize: 14 };
					return v;
				}),
		});

		// Simulate old data
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
		yarray.push([{ key: 'theme', val: { mode: 'dark' }, ts: 0 }]);

		// Read should migrate
		const result = kv.get('theme');
		expect(result.status).toBe('valid');
		if (result.status === 'valid') {
			expect(result.value.fontSize).toBe(14);
		}
	});
});
