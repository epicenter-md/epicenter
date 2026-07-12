import { expect, test } from 'bun:test';
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
