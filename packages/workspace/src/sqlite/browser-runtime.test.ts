/**
 * Browser Workspace Runtime Tests
 *
 * Verifies the page-side Worker protocol without opening OPFS.
 *
 * Key behaviors:
 * - list and update use the public row verbs
 * - row-document and KV observation channels fail loudly until Wave 6
 * - row-sync transport actions cross the boundary
 */

import { afterEach, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBrowserWorkspaceRuntime } from './browser-runtime.js';
import type {
	BrowserRuntimeMessage,
	BrowserRuntimeRequest,
} from './browser-runtime-protocol.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const NativeWorker = globalThis.Worker;

class FakeWorker {
	static latest: FakeWorker | undefined;
	readonly operations: BrowserRuntimeRequest['operation'][] = [];
	private readonly messageListeners = new Set<
		(event: MessageEvent<BrowserRuntimeMessage>) => void
	>();

	constructor() {
		FakeWorker.latest = this;
		queueMicrotask(() => this.emit({ type: 'ready' }));
	}

	addEventListener(
		type: string,
		listener: (event: MessageEvent<never>) => void,
	) {
		if (type === 'message') this.messageListeners.add(listener as never);
	}

	postMessage(message: BrowserRuntimeRequest | { type: string }): void {
		if ('type' in message) return;
		this.operations.push(message.operation);
		const value = (() => {
			switch (message.operation.kind) {
				case 'kv-get':
				case 'kv-set':
					return { data: undefined, error: null };
				default:
					return undefined;
			}
		})();
		queueMicrotask(() => {
			this.emit({ type: 'result', id: message.id, value });
		});
	}

	emit(message: BrowserRuntimeMessage): void {
		for (const listener of this.messageListeners) {
			listener(new MessageEvent('message', { data: message }));
		}
	}

	terminate(): void {}
}

afterEach(() => {
	globalThis.Worker = NativeWorker;
	FakeWorker.latest = undefined;
});

const definition = defineWorkspace({
	id: 'browser-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: { theme: field.select(['light', 'dark']) },
});

function createRuntime() {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	return createBrowserWorkspaceRuntime({
		authorityKey: 'browser-authority',
		createBroadcastChannel: () => undefined,
	});
}

test('page sends list and update operations', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	await workspace.tables.notes.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
		title: 'changed',
	});
	expect(FakeWorker.latest?.operations).toEqual([
		{ kind: 'list', table: 'notes' },
		{
			kind: 'update',
			table: 'notes',
			id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			changes: { title: 'changed' },
		},
	]);
});

test('row documents fail loudly until the browser Worker channel lands', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	await expect(
		workspace.tables.notes.document.open('aaaaaaaaaaaaaaaaaaaaaaaa'),
	).rejects.toThrow('Row documents are not yet openable');
	expect(FakeWorker.latest).toBeUndefined();
});

test('KV observation fails loudly until the browser Worker channel lands', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	expect(() => workspace.kv.observe('theme', () => undefined)).toThrow(
		'kv.observe is not yet wired',
	);
	expect(FakeWorker.latest).toBeUndefined();
});

test('worker transport actions pass through to matching HTTP route suffixes', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	const urls: string[] = [];
	await using runtime = createBrowserWorkspaceRuntime({
		authorityKey: 'browser-authority',
		createBroadcastChannel: () => undefined,
		recordSync: {
			baseUrl: 'https://example.test',
			async fetch(input) {
				urls.push(String(input));
				return new Response('{}', {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			},
		},
	});
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	for (const action of ['enroll', 'sync', 'baseline-scan'] as const) {
		FakeWorker.latest?.emit({
			type: 'transport-request',
			transportId: urls.length + 1,
			workspaceId: definition.id,
			action,
			body: {},
		});
		await Promise.resolve();
		await Promise.resolve();
	}
	expect(urls.map((url) => new URL(url).pathname)).toEqual([
		'/api/records/browser-test/enroll',
		'/api/records/browser-test/sync',
		'/api/records/browser-test/baseline-scan',
	]);
});
