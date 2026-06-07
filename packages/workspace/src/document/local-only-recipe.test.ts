/**
 * Local-only recipe: regression guard.
 *
 * Pins the composition a local-only consumer (desktop notes app, offline
 * CLI, test fixture) is meant to use. The recipe constructs a plaintext
 * workspace (no `keyring`) and pairs it with plain IDB + plain
 * BroadcastChannel. No `attachLocalStorage`: that's the cloud-synced
 * composite that requires an owner-scoped keyring. Local-only data has no
 * cloud adversary.
 *
 * If this file ever needs to import from `@epicenter/auth`,
 * `@epicenter/encryption`, or `@epicenter/util`, the
 * primitives have drifted away from the local-only ergonomic that
 * motivated the workspace split. Either rename the test, or fix the
 * primitive.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { attachBroadcastChannel } from './attach-broadcast-channel.js';
import { attachIndexedDb } from './attach-indexed-db.js';
import { field } from '@epicenter/field';
import { defineTable } from './define-table.js';
import { createWorkspace } from './workspace.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

const originalBroadcastChannel = globalThis.BroadcastChannel;

class FakeBroadcastChannel {
	static names: string[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;

	constructor(public name: string) {
		FakeBroadcastChannel.names.push(name);
	}

	postMessage(_message: unknown): void {}

	close(): void {}
}

const NoteDef = defineTable({
	id: field.string(),
	body: field.string(),
});

describe('local-only recipe', () => {
	beforeEach(() => {
		FakeBroadcastChannel.names = [];
		Object.assign(globalThis, {
			BroadcastChannel:
				FakeBroadcastChannel as unknown as typeof BroadcastChannel,
		});
	});

	afterEach(async () => {
		Object.assign(globalThis, { BroadcastChannel: originalBroadcastChannel });
		await new Promise<void>((resolve) => {
			const request = indexedDB.deleteDatabase('local-notes');
			request.onsuccess = () => resolve();
			request.onerror = () => resolve();
			request.onblocked = () => resolve();
		});
	});

	test('persist + broadcast + workspace compose with no auth or encryption', async () => {
		const workspace = createWorkspace({
			id: 'local-notes',
			tables: { notes: NoteDef },
			kv: {},
		});
		const idb = attachIndexedDb(workspace.ydoc);
		attachBroadcastChannel(workspace.ydoc);
		await idb.whenLoaded;

		workspace.tables.notes.set({ id: 'first', body: 'hello local-first' });

		const { data: stored, error } = workspace.tables.notes.get('first');
		expect(error).toBeNull();
		expect(stored).toEqual({ id: 'first', body: 'hello local-first' });

		expect(FakeBroadcastChannel.names).toEqual(['yjs.local-notes']);

		workspace[Symbol.dispose]();
		await idb.whenDisposed;
	});

	test('data survives a fresh open on the same guid', async () => {
		const first = createWorkspace({
			id: 'local-notes',
			tables: { notes: NoteDef },
			kv: {},
		});
		const firstIdb = attachIndexedDb(first.ydoc);
		await firstIdb.whenLoaded;
		first.tables.notes.set({ id: 'persist-me', body: 'survives reload' });
		first[Symbol.dispose]();
		await firstIdb.whenDisposed;

		const second = createWorkspace({
			id: 'local-notes',
			tables: { notes: NoteDef },
			kv: {},
		});
		const secondIdb = attachIndexedDb(second.ydoc);
		await secondIdb.whenLoaded;

		const { data: stored } = second.tables.notes.get('persist-me');
		expect(stored).toEqual({
			id: 'persist-me',
			body: 'survives reload',
		});

		second[Symbol.dispose]();
		await secondIdb.whenDisposed;
	});
});
