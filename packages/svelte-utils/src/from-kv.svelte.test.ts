import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import {
	type AsyncKv,
	asyncWorkspaceHandle,
	defineKv,
} from '@epicenter/workspace/sqlite';
import { fromKv, type ObservableKv } from './from-kv.svelte.js';

test('SQLite KV binding reads and writes one declared key', () => {
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

test('async SQLite KV binding hydrates and follows effective committed values', async () => {
	const definitions = {
		theme: defineKv(
			field.select(['light', 'dark']),
			(): 'light' | 'dark' => 'light',
		),
	};
	let resolveSnapshot!: (value: 'light' | 'dark') => void;
	const snapshot = new Promise<'light' | 'dark'>((resolve) => {
		resolveSnapshot = resolve;
	});
	let observer:
		| ((values: Readonly<Record<string, unknown>>) => void)
		| undefined;
	const writes: string[] = [];
	let unobserved = false;
	const kv = {
		[asyncWorkspaceHandle]: 'kv',
		get() {
			observer?.({ theme: 'dark' });
			return snapshot;
		},
		set: async (_key: string, value: unknown) => {
			writes.push(`set:${value}`);
		},
		clear: async () => {
			writes.push('clear');
		},
		observe(callback: (values: Readonly<Record<string, unknown>>) => void) {
			observer = callback;
			return () => {
				unobserved = true;
			};
		},
	} as unknown as AsyncKv<typeof definitions>;

	const theme = fromKv(kv, 'theme');
	expect(theme.current).toBeUndefined();
	observer?.({ unrelated: 1 });
	resolveSnapshot('light');
	await theme.whenReady;
	expect(theme.current).toBe('dark');

	await theme.set('light');
	expect(writes).toEqual(['set:light']);
	// Writes are not optimistic: only the committed effective value changes UI.
	expect(theme.current).toBe('dark');
	observer?.({ theme: 'light' });
	expect(theme.current).toBe('light');

	await theme.clear();
	expect(writes).toEqual(['set:light', 'clear']);
	theme[Symbol.dispose]();
	expect(unobserved).toBeTrue();
});
