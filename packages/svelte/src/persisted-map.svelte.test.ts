/**
 * A refused write is a person's edit that storage would not take.
 *
 * The contract is that the edit still happens: `set` accepts into memory
 * whether or not `localStorage` cooperates, and the failure is reported rather
 * than thrown. That leaves memory ahead of storage on purpose, and it is only
 * safe while nothing reads storage back over the top of it.
 *
 * The `focus` listener did exactly that, so these tests exist to keep it from
 * doing it again.
 */
import { expect, mock, test } from 'bun:test';

// A `SvelteMap` needs no reactive runtime for what these assert; a plain Map
// answers `get`/`set` identically and keeps this a plain bun test.
mock.module('svelte/reactivity', () => ({ SvelteMap: Map }));

import { type } from 'arktype';
import { createPersistedMap, defineEntry } from './persisted-map.svelte.js';

type Listener = () => void;

/** One window's worth of the platform this module actually touches. */
function installWindow(storage: {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}) {
	const listeners = new Map<string, Listener[]>();
	(globalThis as unknown as { window: unknown }).window = {
		localStorage: storage,
		addEventListener(event: string, listener: Listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		},
	};
	return {
		fire(event: string) {
			for (const listener of listeners.get(event) ?? []) listener();
		},
	};
}

/** Storage that takes writes until it is told to stop. */
function failableStorage() {
	const items = new Map<string, string>();
	const state = { refusing: false };
	return {
		state,
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem(key: string, value: string) {
			if (state.refusing) throw new Error('QuotaExceededError');
			items.set(key, value);
		},
	};
}

const DEFINITIONS = {
	theme: defineEntry(type("'light' | 'dark'"), 'dark' as const),
};

test('a refused write is accepted into memory and reported', () => {
	const storage = failableStorage();
	installWindow(storage);
	const refused: string[] = [];
	const settings = createPersistedMap({
		prefix: 'test.',
		definitions: DEFINITIONS,
		onUpdateError: (key) => refused.push(key),
	});

	storage.state.refusing = true;
	settings.set('theme', 'light');

	// The edit happened. Storage's refusal is not a veto on the person.
	expect(settings.get('theme')).toBe('light');
	expect(refused).toEqual(['theme']);
	expect(storage.items.get('test.theme')).toBeUndefined();
});

test('a focus re-read does not clobber a value storage refused', () => {
	const storage = failableStorage();
	const win = installWindow(storage);
	const settings = createPersistedMap({
		prefix: 'test.',
		definitions: DEFINITIONS,
		onUpdateError: () => undefined,
	});

	storage.state.refusing = true;
	settings.set('theme', 'light');
	win.fire('focus');

	// The bug this pins: focus re-reads every key, and the stale bytes on disk
	// used to silently replace what the person just typed.
	expect(settings.get('theme')).toBe('light');
});

test('a write that succeeds again makes the key re-readable', () => {
	const storage = failableStorage();
	const win = installWindow(storage);
	const settings = createPersistedMap({
		prefix: 'test.',
		definitions: DEFINITIONS,
		onUpdateError: () => undefined,
	});

	storage.state.refusing = true;
	settings.set('theme', 'light');
	storage.state.refusing = false;
	settings.set('theme', 'dark');

	// Storage has caught up, so the key stops being held back from re-reads.
	expect(storage.items.get('test.theme')).toBe('"dark"');
	win.fire('focus');
	expect(settings.get('theme')).toBe('dark');
});
