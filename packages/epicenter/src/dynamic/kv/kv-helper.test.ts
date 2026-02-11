import { describe, expect, test } from 'bun:test';
import { Temporal } from 'temporal-polyfill';
import * as Y from 'yjs';
import {
	boolean,
	DateTimeString,
	date as dateField,
	integer,
	real,
	select,
	tags,
	text,
} from '../schema';
import { createKv } from './create-kv';

describe('KV Helpers', () => {
	describe('Basic Operations', () => {
		test('text field: get() returns valid result with correct value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'username' })]);

			kv.set('username', 'alice');
			const result = kv.get('username');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('alice');
			}
		});

		test('text field: get() returns default value when not set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'role', default: 'user' })]);

			const result = kv.get('role');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('user');
			}
		});

		test('text field: get() returns null for nullable fields with no default', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'bio', nullable: true })]);

			const result = kv.get('bio');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('text field: set() updates value correctly', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'username' })]);

			kv.set('username', 'alice');
			let result = kv.get('username');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('alice');
			}

			kv.set('username', 'bob');
			result = kv.get('username');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('bob');
			}
		});

		test('text field: reset() restores default value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'role', default: 'user' })]);

			kv.set('role', 'admin');
			let result = kv.get('role');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('admin');
			}

			kv.reset('role');
			result = kv.get('role');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('user');
			}
		});

		test('integer field: get() returns valid result with correct value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [integer({ id: 'count' })]);

			kv.set('count', 42);
			const result = kv.get('count');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(42);
			}
		});

		test('integer field: get() returns default value when not set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			const result = kv.get('count');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(0);
			}
		});

		test('integer field: set() updates value correctly', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			kv.set('count', 10);
			let result = kv.get('count');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(10);
			}

			kv.set('count', 20);
			result = kv.get('count');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(20);
			}
		});

		test('integer field: reset() restores default value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			kv.set('count', 100);
			kv.reset('count');
			const result = kv.get('count');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(0);
			}
		});

		test('real field: get() returns valid result with correct value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [real({ id: 'price' })]);

			kv.set('price', 19.99);
			const result = kv.get('price');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(19.99);
			}
		});

		test('real field: get() returns default value when not set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [real({ id: 'price', default: 0.0 })]);

			const result = kv.get('price');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(0.0);
			}
		});

		test('boolean field: get() returns valid result with correct value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [boolean({ id: 'enabled' })]);

			kv.set('enabled', true);
			let result = kv.get('enabled');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(true);
			}

			kv.set('enabled', false);
			result = kv.get('enabled');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(false);
			}
		});

		test('boolean field: get() returns default value when not set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [boolean({ id: 'enabled', default: false })]);

			const result = kv.get('enabled');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(false);
			}
		});

		test('boolean field: reset() restores default value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [boolean({ id: 'enabled', default: false })]);

			kv.set('enabled', true);
			kv.reset('enabled');
			const result = kv.get('enabled');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(false);
			}
		});

		test('select field: get() returns valid result with correct value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({ id: 'theme', options: ['light', 'dark'] }),
			]);

			kv.set('theme', 'dark');
			const result = kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('dark');
			}
		});

		test('select field: get() returns default value when not set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
			]);

			const result = kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('light');
			}
		});

		test('select field: set() updates value correctly', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
			]);

			kv.set('theme', 'dark');
			let result = kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('dark');
			}

			kv.set('theme', 'light');
			result = kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('light');
			}
		});

		test('select field: reset() restores default value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
			]);

			kv.set('theme', 'dark');
			kv.reset('theme');
			const result = kv.get('theme');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('light');
			}
		});

		test('date field: get() returns valid result with correct value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [dateField({ id: 'last_sync' })]);

			const now = Temporal.ZonedDateTime.from('2024-01-01T05:00:00.000Z[UTC]');
			const nowString = DateTimeString.stringify(now);
			kv.set('last_sync', nowString);
			const result = kv.get('last_sync');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(nowString);
			}
		});

		test('date field: get() returns default value when not set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const defaultDate = Temporal.ZonedDateTime.from(
				'2024-01-01T00:00:00.000+00:00[UTC]',
			);
			const kv = createKv(ydoc, [
				dateField({ id: 'last_sync', default: defaultDate }),
			]);

			const result = kv.get('last_sync');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(DateTimeString.stringify(defaultDate));
			}
		});

		test('date field: get() returns null for nullable fields with no default', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				dateField({ id: 'last_sync', nullable: true }),
			]);

			const result = kv.get('last_sync');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('date field: set() updates value correctly', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [dateField({ id: 'last_sync' })]);

			const date1 = Temporal.ZonedDateTime.from(
				'2024-01-01T05:00:00.000Z[UTC]',
			);
			const date2 = Temporal.ZonedDateTime.from(
				'2024-01-02T05:00:00.000Z[UTC]',
			);
			const date1String = DateTimeString.stringify(date1);
			const date2String = DateTimeString.stringify(date2);

			kv.set('last_sync', date1String);
			let result = kv.get('last_sync');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(date1String);
			}

			kv.set('last_sync', date2String);
			result = kv.get('last_sync');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(date2String);
			}
		});

		test('date field: reset() restores default value', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const defaultDate = Temporal.ZonedDateTime.from(
				'2024-01-01T00:00:00.000+00:00[UTC]',
			);
			const kv = createKv(ydoc, [
				dateField({ id: 'last_sync', default: defaultDate }),
			]);

			const newDate = Temporal.ZonedDateTime.from(
				'2024-02-01T00:00:00.000+00:00[UTC]',
			);
			kv.set('last_sync', DateTimeString.stringify(newDate));
			kv.reset('last_sync');
			const result = kv.get('last_sync');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(DateTimeString.stringify(defaultDate));
			}
		});
	});

	describe('Tags Fields', () => {
		test('tags field: get() returns plain array', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				tags({
					id: 'tags',
					options: ['typescript', 'javascript', 'python'],
				}),
			]);

			kv.set('tags', ['typescript', 'javascript']);
			const result = kv.get('tags');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toEqual(['typescript', 'javascript']);
			}
		});

		test('tags field: set() replaces existing content', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				tags({
					id: 'tags',
					options: ['typescript', 'javascript', 'python'],
				}),
			]);

			kv.set('tags', ['typescript']);
			kv.set('tags', ['python', 'javascript']);
			const result = kv.get('tags');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toEqual(['python', 'javascript']);
			}
		});

		test('tags field without options: allows any strings', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [tags({ id: 'categories' })]);

			kv.set('categories', ['anything', 'goes', 'here']);
			const result = kv.get('categories');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toEqual(['anything', 'goes', 'here']);
			}
		});
	});

	describe('Observe', () => {
		test('observeChanges() fires callback with change event when value changes', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
			]);

			const values: string[] = [];
			kv.observeKey('theme', (change) => {
				if (change.action !== 'delete') {
					values.push(change.newValue);
				}
			});

			kv.set('theme', 'dark');
			kv.set('theme', 'light');

			expect(values).toEqual(['dark', 'light']);
		});

		test('observeChanges() only fires for the specific key, not other keys', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
				integer({ id: 'count', default: 0 }),
			]);

			const themeValues: string[] = [];
			kv.observeKey('theme', (change) => {
				if (change.action !== 'delete') {
					themeValues.push(change.newValue);
				}
			});

			const countValues: number[] = [];
			kv.observeKey('count', (change) => {
				if (change.action !== 'delete') {
					countValues.push(change.newValue);
				}
			});

			kv.set('theme', 'dark');
			kv.set('count', 42);
			kv.set('theme', 'light');

			expect(themeValues).toEqual(['dark', 'light']);
			expect(countValues).toEqual([42]);
		});

		test('observeChanges() unsubscribe function stops callbacks', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			const values: number[] = [];
			const unsubscribe = kv.observeKey('count', (change) => {
				if (change.action !== 'delete') {
					values.push(change.newValue);
				}
			});

			kv.set('count', 1);
			kv.set('count', 2);
			unsubscribe();
			kv.set('count', 3);

			expect(values).toEqual([1, 2]);
		});

		test('observeChanges() fires when tags array is set', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				tags({ id: 'tags', options: ['a', 'b', 'c'] }),
			]);

			let callCount = 0;
			kv.observeKey('tags', () => {
				callCount++;
			});

			kv.set('tags', ['a']);
			expect(callCount).toBe(1);
		});
	});

	describe('Edge Cases', () => {
		test('multiple sets in sequence', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			kv.set('count', 1);
			kv.set('count', 2);
			kv.set('count', 3);
			kv.set('count', 4);
			const result = kv.get('count');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(4);
			}
		});

		test('setting same value twice', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
			]);

			const values: string[] = [];
			kv.observeKey('theme', (change) => {
				if (change.action !== 'delete') {
					values.push(change.newValue);
				}
			});

			kv.set('theme', 'dark');
			kv.set('theme', 'dark');
			kv.set('theme', 'dark');

			expect(values).toEqual(['dark', 'dark', 'dark']);
		});

		test('interaction between multiple KV fields', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
				integer({ id: 'font_size', default: 14 }),
				boolean({ id: 'show_line_numbers', default: true }),
			]);

			kv.set('theme', 'dark');
			kv.set('font_size', 16);
			kv.set('show_line_numbers', false);

			const themeResult = kv.get('theme');
			const fontResult = kv.get('font_size');
			const lineResult = kv.get('show_line_numbers');

			expect(themeResult.status).toBe('valid');
			expect(fontResult.status).toBe('valid');
			expect(lineResult.status).toBe('valid');

			if (themeResult.status === 'valid') {
				expect(themeResult.value).toBe('dark');
			}
			if (fontResult.status === 'valid') {
				expect(fontResult.value).toBe(16);
			}
			if (lineResult.status === 'valid') {
				expect(lineResult.value).toBe(false);
			}

			kv.reset('theme');
			const resetTheme = kv.get('theme');
			expect(resetTheme.status).toBe('valid');
			if (resetTheme.status === 'valid') {
				expect(resetTheme.value).toBe('light');
			}

			const stillFont = kv.get('font_size');
			const stillLine = kv.get('show_line_numbers');
			if (stillFont.status === 'valid') {
				expect(stillFont.value).toBe(16);
			}
			if (stillLine.status === 'valid') {
				expect(stillLine.value).toBe(false);
			}
		});

		test('nullable field: set to null explicitly', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'bio', nullable: true })]);

			kv.set('bio', 'Hello');
			let result = kv.get('bio');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('Hello');
			}

			kv.set('bio', null);
			result = kv.get('bio');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('nullable field with default: set to null clears default', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				text({ id: 'role', nullable: true, default: 'user' }),
			]);

			let result = kv.get('role');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('user');
			}

			kv.set('role', null);
			result = kv.get('role');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('reset on nullable field with no default sets to null', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'bio', nullable: true })]);

			kv.set('bio', 'Hello');
			let result = kv.get('bio');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('Hello');
			}

			kv.reset('bio');
			result = kv.get('bio');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('reset on non-nullable field with no default returns not_found status', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [text({ id: 'username' })]);

			kv.set('username', 'alice');
			let result = kv.get('username');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('alice');
			}

			kv.reset('username');
			result = kv.get('username');
			expect(result.status).toBe('not_found');
			if (result.status === 'not_found') {
				expect(result.key).toBe('username');
			}
		});

		test('toJSON() serializes all values', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
				integer({ id: 'count', default: 0 }),
				boolean({ id: 'enabled', default: true }),
			]);

			kv.set('theme', 'dark');
			kv.set('count', 42);
			kv.set('enabled', true); // Must set explicitly - toJSON only returns stored values, not defaults

			const json = kv.toJSON();
			expect(json).toEqual({
				theme: 'dark',
				count: 42,
				enabled: true,
			});
		});

		test('clearAll() removes all values', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const kv = createKv(ydoc, [
				select({
					id: 'theme',
					options: ['light', 'dark'],
					default: 'light',
				}),
				integer({ id: 'count', default: 0 }),
			]);

			kv.set('theme', 'dark');
			kv.set('count', 42);

			kv.clear();

			const themeResult = kv.get('theme');
			const countResult = kv.get('count');
			expect(themeResult.status).toBe('valid');
			expect(countResult.status).toBe('valid');
			if (themeResult.status === 'valid') {
				expect(themeResult.value).toBe('light');
			}
			if (countResult.status === 'valid') {
				expect(countResult.value).toBe(0);
			}
		});
	});

	describe('Validation', () => {
		test('get() returns invalid status when value type mismatches schema', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const yarray = ydoc.getArray<{ key: string; val: unknown; ts: number }>(
				'kv',
			);

			// Directly set invalid data (simulating sync from corrupted peer)
			yarray.push([{ key: 'count', val: 'not a number', ts: Date.now() }]);

			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			const result = kv.get('count');
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.key).toBe('count');
				expect(result.error.context.key).toBe('count');
			}
		});

		test('observeChanges() receives raw values even for invalid data', () => {
			const ydoc = new Y.Doc({ guid: 'test-kv' });
			const yarray = ydoc.getArray<{ key: string; val: unknown; ts: number }>(
				'kv',
			);

			const kv = createKv(ydoc, [integer({ id: 'count', default: 0 })]);

			let receivedValue: unknown = null;
			kv.observeKey('count', (change) => {
				if (change.action !== 'delete') {
					receivedValue = change.newValue;
				}
			});

			// Directly set invalid data to YJS (simulating sync from corrupted peer)
			yarray.push([{ key: 'count', val: 'invalid value', ts: Date.now() }]);

			// observeChanges receives raw values without validation
			expect(receivedValue).toBe('invalid value');
		});
	});
});
