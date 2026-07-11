import { describe, expect, test } from 'bun:test';
import { PersistedAuth } from './auth-types.js';
import {
	createSerializedPersistedAuthStorage,
	createWebStoragePersistedAuthStorage,
	loadPersistedAuthStorage,
	serializePersistedAuth,
} from './persisted-auth-storage.js';

const cell = PersistedAuth.assert({
	grant: {
		accessToken: 'access',
		refreshToken: 'refresh',
		accessTokenExpiresAt: 1_000_000,
	},
	principalId: 'user-1',
});

describe('createWebStoragePersistedAuthStorage', () => {
	test('treats a corrupt cell as signed out', () => {
		const storage = new MemoryStorage();
		storage.setItem('auth', '{');

		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage,
		});

		expect(persistedAuthStorage.initial).toBeNull();
	});

	test('treats a missing cell as signed out', () => {
		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage: new MemoryStorage(),
		});

		expect(persistedAuthStorage.initial).toBeNull();
	});

	test('set(null) removes the key', () => {
		const storage = new MemoryStorage();
		storage.setItem('auth', 'whatever');

		const persistedAuthStorage = createWebStoragePersistedAuthStorage({
			key: 'auth',
			storage,
		});
		persistedAuthStorage.set(null);

		expect(storage.getItem('auth')).toBeNull();
	});
});

describe('createSerializedPersistedAuthStorage', () => {
	test('decodes the preloaded snapshot and forwards serialized writes', async () => {
		const written: Array<string | null> = [];
		const persistedAuthStorage = createSerializedPersistedAuthStorage({
			initial: serializePersistedAuth(cell),
			write: (serialized) => {
				written.push(serialized);
			},
		});

		expect(persistedAuthStorage.initial).toEqual(cell);
		await persistedAuthStorage.set(cell);
		await persistedAuthStorage.set(null);
		expect(written).toEqual([serializePersistedAuth(cell), null]);
	});

	test('treats a corrupt preloaded snapshot as signed out', () => {
		const persistedAuthStorage = createSerializedPersistedAuthStorage({
			initial: '{',
			write: () => {},
		});

		expect(persistedAuthStorage.initial).toBeNull();
	});
});

describe('loadPersistedAuthStorage', () => {
	type TrackingStore = {
		read: () => Promise<string | null>;
		write: (serialized: string | null) => Promise<void>;
		written: Array<string | null>;
	};

	function trackingStore(initial: string | null): TrackingStore {
		let current = initial;
		const written: Array<string | null> = [];
		return {
			written,
			read: () => Promise.resolve(current),
			write: (serialized) => {
				written.push(serialized);
				current = serialized;
				return Promise.resolve();
			},
		};
	}

	test('hydrates initial from the async read', async () => {
		const store = trackingStore(serializePersistedAuth(cell));

		const persistedAuthStorage = await loadPersistedAuthStorage(store);

		expect(persistedAuthStorage.initial).toEqual(cell);
	});

	test('a corrupt async cell hydrates as signed out', async () => {
		const persistedAuthStorage = await loadPersistedAuthStorage(
			trackingStore('{'),
		);

		expect(persistedAuthStorage.initial).toBeNull();
	});

	test('set forwards a serialized write to the store', async () => {
		const store = trackingStore(null);
		const persistedAuthStorage = await loadPersistedAuthStorage(store);

		await persistedAuthStorage.set(cell);

		expect(store.written).toEqual([serializePersistedAuth(cell)]);
	});

	test('set(null) forwards a remove to the store', async () => {
		const store = trackingStore(serializePersistedAuth(cell));
		const persistedAuthStorage = await loadPersistedAuthStorage(store);

		await persistedAuthStorage.set(null);

		expect(store.written).toEqual([null]);
	});
});

class MemoryStorage implements Storage {
	readonly #items = new Map<string, string>();

	get length(): number {
		return this.#items.size;
	}

	clear(): void {
		this.#items.clear();
	}

	getItem(key: string): string | null {
		return this.#items.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#items.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#items.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#items.set(key, value);
	}
}
