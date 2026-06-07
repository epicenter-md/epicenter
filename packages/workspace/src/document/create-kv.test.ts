/**
 * createKv — set/get/delete/observe over EncryptedYKeyValueLww with validate-or-default semantics.
 */

import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { defineKv } from './define-kv.js';
import { KV_KEY } from './keys.js';
import { createKv } from './kv.js';

const themeSchema = Type.Object({
	mode: Type.Enum(['light', 'dark']),
});
const themeDefault = () => ({ mode: 'light' as const });

test('set stores a value that get returns', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	kv.set('theme', { mode: 'dark' });
	expect(kv.get('theme')).toEqual({ mode: 'dark' });
});

test('get returns defaultValue for unset key', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('delete causes get to return defaultValue', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
	const kv = createKv(ykv, {
		theme: defineKv(themeSchema, themeDefault),
	});

	kv.set('theme', { mode: 'dark' });
	expect(kv.get('theme')).toEqual({ mode: 'dark' });

	kv.delete('theme');
	expect(kv.get('theme')).toEqual({ mode: 'light' });
});

test('get returns defaultValue for invalid stored data', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
	const kv = createKv(ykv, {
		count: defineKv(Type.Number(), () => 0),
	});

	// Write garbage directly to the Y.Array
	ykv.yarray.push([{ key: 'count', val: 'not-a-number', ts: 0 }]);

	expect(kv.get('count')).toBe(0);
});

test('observeAll fires for set changes with correct key and value', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
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
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
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
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
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

test('observeAll skips invalid values', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
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

	// observeAll should only include the valid theme change, not the invalid count
	expect(changes).toHaveLength(1);
	const firstChange = changes[0];
	if (!firstChange) throw new Error('Expected first change map');
	expect(firstChange.has('count')).toBe(false);
	expect(firstChange.has('theme')).toBe(true);

	unsubscribe();
});

test('observeAll skips unknown keys', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
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

test('observeAll returns an unsubscribe function that works', () => {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, KV_KEY);
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
