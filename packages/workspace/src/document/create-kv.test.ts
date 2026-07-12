/**
 * createKv: set/get/delete/observe over YKeyValueLww with validate-or-default semantics.
 */

import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { defineKv } from './define-kv.js';
import { KV_KEY } from './keys.js';
import { createKv } from './kv.js';
import { YKeyValueLww, type YKeyValueLwwEntry } from './y-keyvalue/index.js';

const themeSchema = Type.Object({
	mode: Type.Enum(['light', 'dark']),
});
const themeDefault = () => ({ mode: 'light' as const });

function setupYkv() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const ykv = new YKeyValueLww<unknown>(yarray);
	return { ydoc, ykv };
}

test('set stores a value that get returns', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	kv.set('theme', { mode: 'dark' });
	expect(kv.get('theme')).toEqual({ mode: 'dark' });
});

test('get returns defaultValue for unset key', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('delete causes get to return defaultValue', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	kv.set('theme', { mode: 'dark' });
	expect(kv.get('theme')).toEqual({ mode: 'dark' });

	kv.delete('theme');
	expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('get returns defaultValue for invalid stored data', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		count: defineKv(Type.Number(), () => 0),
	});

	// Write garbage directly to the Y.Array
	ykv.yarray.push([{ key: 'count', val: 'not-a-number', ts: 0 }]);

	expect(kv.get('count')).toBe(0);
});

test('observeAll fires for set changes with correct key and value', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	kv.set('theme', { mode: 'dark' });

	expect(changes).toHaveLength(1);
	const firstChange = changes[0];
	if (!firstChange) throw new Error('Expected first change map');
	expect(firstChange.has('theme')).toBe(true);
	const themeChange = firstChange.get('theme');
	expect(themeChange.type).toBe('set');
	expect(themeChange.value).toEqual({ mode: 'dark' });

	unsubscribe();
});

test('observeAll fires for delete changes', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	kv.set('theme', { mode: 'dark' });

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	kv.delete('theme');

	expect(changes).toHaveLength(1);
	const firstChange = changes[0];
	if (!firstChange) throw new Error('Expected first change map');
	expect(firstChange.has('theme')).toBe(true);
	const themeChange = firstChange.get('theme');
	expect(themeChange.type).toBe('delete');

	unsubscribe();
});

test('observeAll batches multiple changes in a single callback', () => {
	const { ydoc, ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
		fontSize: defineKv(Type.Number(), () => 14),
	});

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	// Set two keys in a single transaction
	ydoc.transact(() => {
		kv.set('theme', { mode: 'dark' });
		kv.set('fontSize', 16);
	});

	// Should fire once with both changes
	expect(changes).toHaveLength(1);
	const firstChange = changes[0];
	if (!firstChange) throw new Error('Expected first change map');
	expect(firstChange.size).toBe(2);
	expect(firstChange.has('theme')).toBe(true);
	expect(firstChange.has('fontSize')).toBe(true);

	const themeChange = firstChange.get('theme');
	expect(themeChange.type).toBe('set');
	expect(themeChange.value).toEqual({ mode: 'dark' });

	const fontSizeChange = firstChange.get('fontSize');
	expect(fontSizeChange.type).toBe('set');
	expect(fontSizeChange.value).toBe(16);

	unsubscribe();
});

test('observeAll reports invalid winning values as the effective default', () => {
	const { ydoc, ykv } = setupYkv();
	const kv = createKv(ykv, {
		count: defineKv(Type.Number(), () => 0),
		theme: defineKv(themeSchema, themeDefault),
	});

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	// Write garbage directly to the Y.Array (simulating corruption)
	ydoc.transact(() => {
		ykv.yarray.push([{ key: 'count', val: 'not-a-number', ts: Date.now() }]);
		// Also set a valid value to trigger the observer
		kv.set('theme', { mode: 'dark' });
	});

	// The invalid winner notifies observers with what get() now returns: the
	// effective default. The stored bytes stay untouched.
	expect(changes).toHaveLength(1);
	const firstChange = changes[0];
	if (!firstChange) throw new Error('Expected first change map');
	expect(firstChange.get('count')).toEqual({ type: 'set', value: 0 });
	expect(firstChange.has('theme')).toBe(true);
	expect(kv.get('count')).toBe(0);
	expect(ykv.get('count')).toBe('not-a-number');

	unsubscribe();
});

test('observeAll skips unknown keys', () => {
	const { ydoc, ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	// Write directly to Y.Array with a key not in definitions
	ydoc.transact(() => {
		ykv.yarray.push([{ key: 'unknownKey', val: 'some-value', ts: Date.now() }]);
		// Also set a valid value to trigger the observer
		kv.set('theme', { mode: 'dark' });
	});

	// observeAll should only include the valid theme change, not the unknown key
	expect(changes).toHaveLength(1);
	const firstChange = changes[0];
	if (!firstChange) throw new Error('Expected first change map');
	expect(firstChange.has('unknownKey')).toBe(false);
	expect(firstChange.has('theme')).toBe(true);

	unsubscribe();
});

test('keys lists every defined key in declaration order', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
		fontSize: defineKv(Type.Number(), () => 14),
	});

	expect(kv.keys).toEqual(['theme', 'fontSize']);
});

test('getDefault returns a fresh value on every call', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	const first = kv.getDefault('theme');
	const second = kv.getDefault('theme');
	expect(first).toEqual({ mode: 'light' });
	expect(second).toEqual(first);
	expect(second).not.toBe(first);
});

test('reset writes every default in one observer batch', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
		fontSize: defineKv(Type.Number(), () => 14),
	});

	kv.set('theme', { mode: 'dark' });
	kv.set('fontSize', 22);

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	kv.reset();

	expect(kv.get('theme')).toEqual({ mode: 'light' });
	expect(kv.get('fontSize')).toBe(14);
	expect(changes).toHaveLength(1);

	unsubscribe();
});

test('observeAll returns an unsubscribe function that works', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	const changes: Array<Map<string, any>> = [];
	const unsubscribe = kv.observeAll((changeMap) => {
		changes.push(new Map(changeMap));
	});

	// First change should be observed
	kv.set('theme', { mode: 'dark' });
	expect(changes).toHaveLength(1);

	// Unsubscribe
	unsubscribe();

	// Second change should not be observed
	kv.set('theme', { mode: 'light' });
	expect(changes).toHaveLength(1);
});

test('observe reports an invalid winning value as the effective default', () => {
	const { ydoc, ykv } = setupYkv();
	const kv = createKv(ykv, {
		count: defineKv(Type.Number(), () => 0),
	});

	const changes: unknown[] = [];
	const unsubscribe = kv.observe('count', (change) => changes.push(change));

	kv.set('count', 5);
	ydoc.transact(() => {
		ykv.yarray.push([{ key: 'count', val: 'garbage', ts: Date.now() * 2 }]);
	});

	// Readers re-render with what get() now returns; stored bytes are intact.
	expect(changes).toEqual([
		{ type: 'set', value: 5 },
		{ type: 'set', value: 0 },
	]);
	expect(kv.get('count')).toBe(0);
	expect(ykv.get('count')).toBe('garbage');

	unsubscribe();
});

test('every accessor throws on an undeclared key', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});
	const undeclared = 'missing' as 'theme';

	expect(() => kv.get(undeclared)).toThrow("Unknown KV key 'missing'");
	expect(() => kv.set(undeclared, { mode: 'dark' })).toThrow(
		"Unknown KV key 'missing'",
	);
	expect(() => kv.getDefault(undeclared)).toThrow("Unknown KV key 'missing'");
	expect(() => kv.delete(undeclared)).toThrow("Unknown KV key 'missing'");
	expect(() => kv.observe(undeclared, () => {})).toThrow(
		"Unknown KV key 'missing'",
	);
});

test('declared keys must fit the key byte budget', () => {
	const { ykv } = setupYkv();
	const oversizedKey = 'k'.repeat(513);

	expect(() =>
		createKv(ykv, {
			[oversizedKey]: defineKv(Type.Number(), () => 0),
		}),
	).toThrow('key budget');
	expect(() =>
		createKv(ykv, {
			['k'.repeat(512)]: defineKv(Type.Number(), () => 0),
		}),
	).not.toThrow();
});

test('set and reset enforce the encoded value byte budget', () => {
	const { ykv } = setupYkv();
	const kv = createKv(ykv, {
		note: defineKv(Type.String(), () => ''),
	});

	const oversized = 'x'.repeat(64 * 1024);
	expect(() => kv.set('note', oversized)).toThrow('budget');
	expect(ykv.get('note')).toBeUndefined();

	// A value under the budget still writes.
	kv.set('note', 'small');
	expect(kv.get('note')).toBe('small');

	const oversizedDefault = createKv(ykv, {
		blob: defineKv(Type.String(), () => 'y'.repeat(64 * 1024)),
	});
	expect(() => oversizedDefault.reset()).toThrow('budget');
});
