/**
 * createKv Tests
 *
 * Verifies key-value helpers over Y.Doc for set/get/delete behavior.
 * KV uses validate-or-default semantics—invalid or missing data returns the default.
 *
 * Key behaviors:
 * - `get` returns typed values directly (stored value or default)
 * - Invalid stored data falls back to `defaultValue`
 * - `delete` resets a key to its default
 */

import { expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import { createKv } from './create-kv.js';
import { defineKv } from './define-kv.js';

test('set stores a value that get returns', () => {
	const ydoc = new Y.Doc();
	const kv = createKv(ydoc, {
		theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
	});

	kv.set('theme', { mode: 'dark' });
	expect(kv.get('theme')).toEqual({ mode: 'dark' });
});

test('get returns defaultValue for unset key', () => {
	const ydoc = new Y.Doc();
	const kv = createKv(ydoc, {
		theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
	});

	expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('delete causes get to return defaultValue', () => {
	const ydoc = new Y.Doc();
	const kv = createKv(ydoc, {
		theme: defineKv(type({ mode: "'light' | 'dark'" }), { mode: 'light' }),
	});

	kv.set('theme', { mode: 'dark' });
	expect(kv.get('theme')).toEqual({ mode: 'dark' });

	kv.delete('theme');
	expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('get returns defaultValue for invalid stored data', () => {
	const ydoc = new Y.Doc();
	const kv = createKv(ydoc, {
		count: defineKv(type('number'), 0),
	});

	// Write garbage directly to the Y.Array
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('kv');
	yarray.push([{ key: 'count', val: 'not-a-number', ts: 0 }]);

	expect(kv.get('count')).toBe(0);
});
