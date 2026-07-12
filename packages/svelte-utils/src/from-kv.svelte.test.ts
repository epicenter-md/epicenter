import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { Kv } from '@epicenter/workspace';
import { defineKv } from '@epicenter/workspace/sqlite';
import { fromKv, type ObservableKv } from './from-kv.svelte.js';

test('observable KV binding reads and writes one declared key', () => {
	type Values = { theme: 'light' | 'dark'; count: number };
	const values: Values = { theme: 'dark', count: 0 };
	const kv: ObservableKv<Values> = {
		get: (key) => values[key],
		set: (key, value) => {
			values[key] = value;
		},
		clear: () => {},
		observe: () => () => {},
	};
	const theme = fromKv(kv, 'theme');

	expect(theme.current).toBe('dark');
	theme.current = 'light';
	expect(values.theme).toBe('light');
	expect(theme.current).toBe('light');
});

test('preference-plane KV binding reads synchronously and observes one key', () => {
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
