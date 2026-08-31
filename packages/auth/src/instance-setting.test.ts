import { describe, expect, test } from 'bun:test';
import { createInstanceSetting } from './instance-setting.js';

const HOSTED = 'https://api.epicenter.so';
const KEY = 'app.instance';

/** Minimal in-memory `Storage` slice for the sync factory. */
function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
	};
}

describe('createInstanceSetting', () => {
	test('empty storage reads the hosted default', () => {
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage: memoryStorage(),
		});
		expect(setting.read()).toEqual({ baseURL: HOSTED });
		expect(setting.isDefault()).toBe(true);
	});

	test('persists a self-host override and a reopened handle decodes it', () => {
		const storage = memoryStorage();
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage,
		});
		setting.write({ baseURL: 'https://my.box', token: 'tok' });
		expect(setting.read()).toEqual({ baseURL: 'https://my.box', token: 'tok' });
		expect(setting.isDefault()).toBe(false);

		const reopened = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage,
		});
		expect(reopened.read()).toEqual({
			baseURL: 'https://my.box',
			token: 'tok',
		});
	});

	test('clear() reverts to the hosted default and removes the key', () => {
		const storage = memoryStorage({
			[KEY]: JSON.stringify({ baseURL: 'https://my.box', token: 'tok' }),
		});
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage,
		});
		expect(setting.isDefault()).toBe(false);
		setting.clear();
		expect(setting.read()).toEqual({ baseURL: HOSTED });
		expect(setting.isDefault()).toBe(true);
		expect(storage.getItem(KEY)).toBeNull();
	});

	test('a corrupt record reads as the hosted default', () => {
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage: memoryStorage({ [KEY]: 'not json' }),
		});
		expect(setting.read()).toEqual({ baseURL: HOSTED });
	});

	test('ADR-0071: a non-hosted base URL with no token reads as the hosted default', () => {
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage: memoryStorage({
				[KEY]: JSON.stringify({ baseURL: 'https://my.box' }),
			}),
		});
		expect(setting.read()).toEqual({ baseURL: HOSTED });
		expect(setting.isDefault()).toBe(true);
	});

	test('a token against the hosted base URL stays a non-default override', () => {
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage: memoryStorage({
				[KEY]: JSON.stringify({ baseURL: HOSTED, token: 'tok' }),
			}),
		});
		expect(setting.read()).toEqual({ baseURL: HOSTED, token: 'tok' });
		expect(setting.isDefault()).toBe(false);
	});

	test('normalizes the base URL on read', () => {
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage: memoryStorage({
				[KEY]: JSON.stringify({ baseURL: 'https://my.box/', token: 'tok' }),
			}),
		});
		expect(setting.read().baseURL).toBe('https://my.box');
	});

	test('undefined storage (SSR) reads the hosted default and persists nothing', () => {
		const setting = createInstanceSetting({
			storageKey: KEY,
			defaultBaseURL: HOSTED,
			storage: undefined,
		});
		expect(setting.read()).toEqual({ baseURL: HOSTED });
		expect(() =>
			setting.write({ baseURL: 'https://my.box', token: 'tok' }),
		).not.toThrow();
	});
});
