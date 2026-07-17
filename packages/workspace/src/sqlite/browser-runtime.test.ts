/**
 * Browser Workspace Runtime Tests
 *
 * Verifies the page-side Worker protocol without opening OPFS.
 *
 * Key behaviors:
 * - list and update use the public row verbs
 * - row documents hydrate, persist, and revoke across the Worker boundary
 * - KV observation re-reads changed values and detaches cleanly
 * - row-sync transport actions cross the boundary
 */

import { afterEach, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { decodeBase64 } from '@epicenter/row-sync';
import { createBrowserWorkspaceRuntime } from './browser-runtime.js';
import type {
	BrowserRuntimeMessage,
	BrowserRuntimeRequest,
} from './browser-runtime-protocol.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const NativeWorker = globalThis.Worker;
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

class FakeWorker {
	static latest: FakeWorker | undefined;
	readonly operations: BrowserRuntimeRequest['operation'][] = [];
	readonly documentParts: Uint8Array[] = [];
	row: Record<string, unknown> | undefined = { title: 'Browser row' };
	theme: 'light' | 'dark' | undefined = 'light';
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
				case 'read-current-row':
					return this.row;
				case 'read-current-document-parts':
					return this.documentParts.map((part) => Uint8Array.from(part));
				case 'admit-document-intent': {
					const intent = message.operation.intent;
					if (intent.kind !== 'update' || !intent.documentUpdate) {
						throw new Error('Expected a document-bearing update intent');
					}
					this.documentParts.push(decodeBase64(intent.documentUpdate));
					return undefined;
				}
				case 'kv-get':
					return { data: this.theme, error: null };
				case 'kv-set':
					this.theme = message.operation.value as 'light' | 'dark';
					return { data: undefined, error: null };
				case 'kv-unset':
					this.theme = undefined;
					return undefined;
				case 'delete':
					this.row = undefined;
					this.documentParts.length = 0;
					return undefined;
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
		storageScopeKey: 'browser-storage-scope',
		createBroadcastChannel: () => undefined,
	});
}

async function settleWorkerBoundary(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
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

test('page row document hydrates edits committed by the Worker acknowledgement', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	const first = await workspace.tables.notes.document.open(ROW_ID);
	first.get('editor').insert(0, 'browser durable');
	await first.whenDurable();
	first[Symbol.dispose]();
	await Promise.resolve();

	using reopened = await workspace.tables.notes.document.open(ROW_ID);
	expect(reopened.get('editor').toString()).toBe('browser durable');
	expect(
		FakeWorker.latest?.operations.some(
			(operation) => operation.kind === 'admit-document-intent',
		),
	).toBe(true);
});

test('remote deletion revokes a page row-document handle', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	using document = await workspace.tables.notes.document.open(ROW_ID);
	FakeWorker.latest?.emit({
		type: 'rows-deleted',
		workspaceId: definition.id,
		addresses: [{ table: 'notes', rowId: ROW_ID }],
	});
	expect(() => document.get('editor')).toThrow('was revoked');
});

test('KV observation emits for a remote value change and stops after unsubscribe', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	let emissions = 0;
	const unsubscribe = workspace.kv.observe('theme', () => {
		emissions += 1;
	});
	await settleWorkerBoundary();

	if (FakeWorker.latest) FakeWorker.latest.theme = 'dark';
	FakeWorker.latest?.emit({
		type: 'records-changed',
		workspaceId: definition.id,
	});
	await settleWorkerBoundary();
	expect(emissions).toBe(1);

	FakeWorker.latest?.emit({
		type: 'records-changed',
		workspaceId: definition.id,
	});
	await settleWorkerBoundary();
	expect(emissions).toBe(1);

	unsubscribe();
	if (FakeWorker.latest) FakeWorker.latest.theme = 'light';
	FakeWorker.latest?.emit({
		type: 'records-changed',
		workspaceId: definition.id,
	});
	await settleWorkerBoundary();
	expect(emissions).toBe(1);
});

test('worker transport actions pass through to matching HTTP route suffixes', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	const urls: string[] = [];
	await using runtime = createBrowserWorkspaceRuntime({
		storageScopeKey: 'browser-storage-scope',
		createBroadcastChannel: () => undefined,
		rowSync: {
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

test('browser runtime disposal revokes retained row-document handles', async () => {
	const runtime = createRuntime();
	const workspace = await runtime.open(definition);
	const document = await workspace.tables.notes.document.open(ROW_ID);

	await runtime[Symbol.asyncDispose]();

	expect(() => document.get('editor')).toThrow(
		'Browser workspace runtime is disposed',
	);
	expect(() => document.transact(() => undefined)).toThrow(
		'Browser workspace runtime is disposed',
	);
});
