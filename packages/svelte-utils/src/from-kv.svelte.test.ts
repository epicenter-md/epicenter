import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { Kv } from '@epicenter/workspace';
import { defineKv } from '@epicenter/workspace/sqlite';
import { fromKv } from './from-kv.svelte.js';

test('KV binding reads synchronously and observes one declared key', () => {
	const definitions = {
		theme: defineKv(
			field.select(['light', 'dark']),
			(): 'light' | 'dark' => 'light',
		),
	};
	const values = new Map<string, unknown>();
	const observers = new Map<string, (change: unknown) => void>();
	let unobserved = false;
	const kv = {
		get: (key: string) => values.get(key) ?? definitions.theme.defaultValue(),
		set: (key: string, value: unknown) => {
			values.set(key, value);
			observers.get(key)?.({ type: 'set', value });
		},
		observe(key: string, callback: (change: unknown) => void) {
			observers.set(key, callback);
			return () => {
				unobserved = true;
			};
		},
	} as unknown as Kv<typeof definitions>;

	const theme = fromKv(kv, 'theme');
	// Absent reads as the effective default, synchronously.
	expect(theme.current).toBe('light');

	theme.current = 'dark';
	expect(theme.current).toBe('dark');
	expect(values.get('theme')).toBe('dark');
	void unobserved;
});
