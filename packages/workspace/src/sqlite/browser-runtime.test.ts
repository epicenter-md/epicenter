/**
 * Browser Workspace Runtime Tests
 *
 * Verifies the page-side ownership boundary without pretending Bun is OPFS.
 * The real SQLite Worker is covered by the Browser smoke test.
 *
 * Key behaviors:
 * - runtime open is inert until the first record operation
 * - committed-write hints stay at runtime construction
 * - IndexedDB persists room manifests and Yjs state across runtime restarts
 * - released document capabilities are revoked and remote sync starts after replay
 */
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbDocumentLocalStore } from './browser-document-store.js';
import { createBrowserWorkspaceRuntime } from './browser-runtime.js';
import type {
	BrowserRuntimeMessage,
	BrowserWorkerInbound,
} from './browser-runtime-protocol.js';
import { document } from './document-definition.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

class FakeWorker extends EventTarget {
	requests: Array<Extract<BrowserWorkerInbound, { id: number }>> = [];
	transportResponses: Array<Extract<BrowserWorkerInbound, { type: string }>> =
		[];
	isTerminated = false;

	constructor() {
		super();
		queueMicrotask(() => this.emit({ type: 'ready' }));
	}

	postMessage(request: BrowserWorkerInbound): void {
		if ('type' in request) {
			this.transportResponses.push(request);
			return;
		}
		this.requests.push(request);
		const value =
			request.operation.kind === 'get'
				? { data: null, error: null }
				: request.operation.kind === 'delete'
					? undefined
					: {};
		queueMicrotask(() => this.emit({ type: 'result', id: request.id, value }));
	}

	terminate(): void {
		this.isTerminated = true;
	}

	emit(message: BrowserRuntimeMessage): void {
		this.dispatchEvent(new MessageEvent('message', { data: message }));
	}
}

function createTestBroadcastChannelFactory() {
	type TestChannel = {
		onmessage: ((event: MessageEvent<unknown>) => void) | null;
		postMessage(message: unknown): void;
		close(): void;
	};
	const channels = new Map<string, Set<TestChannel>>();
	return (name: string): TestChannel => {
		const peers = channels.get(name) ?? new Set<TestChannel>();
		channels.set(name, peers);
		const channel: TestChannel = {
			onmessage: null,
			postMessage(message) {
				for (const peer of peers) {
					if (peer === channel) continue;
					queueMicrotask(() =>
						peer.onmessage?.(new MessageEvent('message', { data: message })),
					);
				}
			},
			close() {
				peers.delete(channel);
				if (peers.size === 0) channels.delete(name);
			},
		};
		peers.add(channel);
		return channel;
	};
}

const workspaceDefinition = defineWorkspace({
	id: 'browser-runtime-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	documents: {
		draft: document.text({ params: { noteId: field.string() } }),
	},
});

test('open stays inert and the first record call crosses one Worker boundary', async () => {
	const createBroadcastChannel = createTestBroadcastChannelFactory();
	let worker: FakeWorker | undefined;
	const OriginalWorker = globalThis.Worker;
	globalThis.Worker = class extends FakeWorker {
		constructor() {
			super();
			worker = this;
		}
	} as unknown as typeof Worker;
	const changes: string[] = [];
	const backgroundErrors: string[] = [];
	const fetched: string[] = [];
	const runtime = createBrowserWorkspaceRuntime({
		authorityKey: crypto.randomUUID(),
		createBroadcastChannel,
		recordSync: {
			baseUrl: 'https://authority.test',
			async fetch(input) {
				fetched.push(String(input));
				return new Response(JSON.stringify({ ok: true }));
			},
		},
		onRecordsChanged(workspaceId) {
			changes.push(workspaceId);
		},
		onBackgroundError(cause, workspaceId) {
			backgroundErrors.push(`${workspaceId}: ${cause.message}`);
		},
	});
	try {
		const workspace = await runtime.open(workspaceDefinition);
		expect(worker).toBeUndefined();
		const reading = workspace.tables.notes.get('missing');
		expect(worker).toBeDefined();
		expect((await reading).data).toBeNull();
		if (!worker) throw new Error('Record call did not create a Worker');
		expect(worker.requests).toHaveLength(1);
		expect(worker.requests[0]?.operation).toEqual({
			kind: 'get',
			table: 'notes',
			id: 'missing',
		});
		worker.emit({
			type: 'records-changed',
			workspaceId: workspaceDefinition.id,
		});
		expect(changes).toEqual([workspaceDefinition.id]);
		worker.emit({
			type: 'transport-request',
			transportId: 1,
			workspaceId: workspaceDefinition.id,
			action: 'pull',
			body: { kind: 'pull' },
		});
		await Bun.sleep(0);
		expect(fetched).toEqual([
			`https://authority.test/api/records/${workspaceDefinition.id}/pull`,
		]);
		expect(worker.transportResponses).toEqual([
			{ type: 'transport-result', transportId: 1, value: { ok: true } },
		]);
		worker.emit({
			type: 'background-error',
			workspaceId: workspaceDefinition.id,
			name: 'Error',
			message: 'retry later',
		});
		expect(backgroundErrors).toEqual([
			`${workspaceDefinition.id}: retry later`,
		]);
	} finally {
		await runtime[Symbol.asyncDispose]();
		globalThis.Worker = OriginalWorker;
	}
	expect(worker?.isTerminated).toBe(true);
});

test('IndexedDB preserves room manifests and rejects storage-ref collisions', async () => {
	const indexedDb = new IDBFactory();
	const name = `browser-document-store-${crypto.randomUUID()}`;
	const manifest = {
		formatVersion: 1 as const,
		storageRef: 'room-a',
		workspaceId: 'notes',
		declaration: 'draft',
		documentFormat: 'text/1',
		params: { noteId: 'note-a' },
	};
	const first = createIndexedDbDocumentLocalStore(name, indexedDb);
	await first.rememberRoom(manifest);
	await first.save(manifest.storageRef, new Uint8Array([1, 2, 3]));
	await first[Symbol.asyncDispose]();

	const reopened = createIndexedDbDocumentLocalStore(name, indexedDb);
	try {
		expect(await reopened.load(manifest.storageRef)).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		await expect(
			reopened.rememberRoom({ ...manifest, workspaceId: 'other' }),
		).rejects.toThrow('another manifest');
	} finally {
		await reopened[Symbol.asyncDispose]();
	}
});

test('document replay precedes sync attachment and released content is revoked', async () => {
	const createBroadcastChannel = createTestBroadcastChannelFactory();
	const OriginalIndexedDb = globalThis.indexedDB;
	globalThis.indexedDB = new IDBFactory();
	const authorityKey = crypto.randomUUID();
	const firstRuntime = createBrowserWorkspaceRuntime({
		authorityKey,
		createBroadcastChannel,
	});
	const indexedDb = globalThis.indexedDB;
	globalThis.indexedDB = OriginalIndexedDb;
	const firstWorkspace = await firstRuntime.open(workspaceDefinition);
	const firstLease = await firstWorkspace.documents.draft.open({ noteId: 'a' });
	firstLease.content.write('persisted draft');
	const releasedContent = firstLease.content;
	firstLease[Symbol.dispose]();
	expect(() => releasedContent.read()).toThrow('lease is disposed');
	await firstRuntime[Symbol.asyncDispose]();

	const hydratedBeforeSync: string[] = [];
	globalThis.indexedDB = indexedDb;
	let secondRuntime: ReturnType<typeof createBrowserWorkspaceRuntime>;
	try {
		secondRuntime = createBrowserWorkspaceRuntime({
			authorityKey,
			createBroadcastChannel,
			attachDocumentSync(ydoc) {
				hydratedBeforeSync.push(ydoc.getText('content').toString());
				return { [Symbol.dispose]() {} };
			},
		});
	} finally {
		globalThis.indexedDB = OriginalIndexedDb;
	}
	try {
		const secondWorkspace = await secondRuntime.open(workspaceDefinition);
		using reopened = await secondWorkspace.documents.draft.open({
			noteId: 'a',
		});
		expect(reopened.content.read()).toBe('persisted draft');
		expect(hydratedBeforeSync).toEqual(['persisted draft']);
	} finally {
		await secondRuntime[Symbol.asyncDispose]();
	}
});

test('independent page runtimes exchange live Yjs updates without a document leader', async () => {
	const createBroadcastChannel = createTestBroadcastChannelFactory();
	const OriginalIndexedDb = globalThis.indexedDB;
	globalThis.indexedDB = new IDBFactory();
	const authorityKey = crypto.randomUUID();
	const firstRuntime = createBrowserWorkspaceRuntime({
		authorityKey,
		createBroadcastChannel,
	});
	const secondRuntime = createBrowserWorkspaceRuntime({
		authorityKey,
		createBroadcastChannel,
	});
	globalThis.indexedDB = OriginalIndexedDb;
	try {
		const firstWorkspace = await firstRuntime.open(workspaceDefinition);
		const secondWorkspace = await secondRuntime.open(workspaceDefinition);
		using first = await firstWorkspace.documents.draft.open({
			noteId: 'shared',
		});
		using second = await secondWorkspace.documents.draft.open({
			noteId: 'shared',
		});
		first.content.write('from first page');
		for (let attempt = 0; attempt < 100; attempt++) {
			if (second.content.read() === 'from first page') break;
			if (attempt === 99) throw new Error('Yjs update did not cross pages');
			await Bun.sleep(5);
		}
		second.content.insert(second.content.read().length, ' and second page');
		for (let attempt = 0; attempt < 100; attempt++) {
			if (first.content.read() === 'from first page and second page') break;
			if (attempt === 99) throw new Error('Yjs reply did not cross pages');
			await Bun.sleep(5);
		}
	} finally {
		await firstRuntime[Symbol.asyncDispose]();
		await secondRuntime[Symbol.asyncDispose]();
	}
});
