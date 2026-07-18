/**
 * Browser Workspace Runtime Tests
 *
 * Verifies the page-side Worker protocol without opening OPFS.
 *
 * Key behaviors:
 * - open waits for one shared Worker initialization acknowledgement
 * - list and update use the public row verbs
 * - KV observation re-reads changed values and detaches cleanly
 * - current-state transport actions cross the boundary
 */

import { afterEach, expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from './browser-runtime.js';
import type {
	BrowserRuntimeMessage,
	BrowserRuntimeRequest,
} from './browser-runtime-protocol.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const NativeWorker = globalThis.Worker;
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function neverOpenWebSocket(): Promise<WebSocket> {
	return new Promise(() => undefined);
}

class FakeWorker {
	static latest: FakeWorker | undefined;
	static openMode: 'resolve' | 'defer' | 'reject' = 'resolve';
	readonly operations: BrowserRuntimeRequest['operation'][] = [];
	readonly manifests: BrowserRuntimeRequest['manifest'][] = [];
	readonly transportResponses: { type: string; pendingReason?: string }[] = [];
	row: Record<string, unknown> | undefined = { title: 'Browser row' };
	theme: 'light' | 'dark' | undefined = 'light';
	private readonly messageListeners = new Set<
		(event: MessageEvent<BrowserRuntimeMessage>) => void
	>();
	private deferredOpen: BrowserRuntimeRequest | undefined;
	private deferredSettlement: BrowserRuntimeRequest | undefined;

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
		if ('type' in message) {
			this.transportResponses.push(message);
			return;
		}
		this.operations.push(message.operation);
		this.manifests.push(message.manifest);
		if (message.operation.kind === 'open') {
			if (FakeWorker.openMode === 'defer') {
				this.deferredOpen = message;
				return;
			}
			queueMicrotask(() => {
				if (FakeWorker.openMode === 'reject') {
					this.emit({
						type: 'error',
						id: message.id,
						name: 'Error',
						message: 'open failed',
					});
					return;
				}
				this.emit({ type: 'result', id: message.id, value: { isReady: true } });
			});
			return;
		}
		if (message.operation.kind === 'sync-settle') {
			this.deferredSettlement = message;
			this.finishSettlement();
			return;
		}
		const value = (() => {
			switch (message.operation.kind) {
				case 'logical-capture':
				case 'capture-visible':
				case 'sync-capture-recovery':
					return {
						rows: [
							{
								table: 'notes',
								rowId: ROW_ID,
								fields: { title: 'Browser row' },
							},
						],
						kv: { theme: 'light' },
					};
				case 'logical-add':
					return undefined;
				case 'logical-delete':
					this.row = undefined;
					this.theme = undefined;
					return undefined;
				case 'read-current-row':
					return this.row;
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
					return undefined;
				default:
					return undefined;
			}
		})();
		queueMicrotask(() => {
			this.emit({ type: 'result', id: message.id, value });
		});
	}

	resolveOpen(): void {
		const request = this.deferredOpen;
		if (!request) throw new Error('No deferred open request');
		this.deferredOpen = undefined;
		this.emit({ type: 'result', id: request.id, value: { isReady: true } });
	}

	private finishSettlement(): void {
		const request = this.deferredSettlement;
		if (!request) return;
		this.deferredSettlement = undefined;
		queueMicrotask(() => {
			this.emit({
				type: 'result',
				id: request.id,
				value: { outcome: 'caught-up' },
			});
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
	FakeWorker.openMode = 'resolve';
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
	return createDeviceBrowserWorkspaceRuntime({
		createBroadcastChannel: () => undefined,
	});
}

test('open waits for Worker initialization', async () => {
	FakeWorker.openMode = 'defer';
	await using runtime = createRuntime();
	let settled = false;
	const opening = runtime.open(definition).then((workspace) => {
		settled = true;
		return workspace;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	expect(FakeWorker.latest?.operations).toEqual([{ kind: 'open' }]);
	FakeWorker.latest?.resolveOpen();
	await opening;
});

test('concurrent opens share one Worker initialization', async () => {
	FakeWorker.openMode = 'defer';
	await using runtime = createRuntime();
	const first = runtime.open(definition);
	const second = runtime.open(definition);
	await Promise.resolve();
	await Promise.resolve();
	expect(FakeWorker.latest?.operations).toEqual([{ kind: 'open' }]);
	FakeWorker.latest?.resolveOpen();
	expect(await first).toBe(await second);
});

test('failed open rejects and retries initialization', async () => {
	FakeWorker.openMode = 'reject';
	await using runtime = createRuntime();
	await expect(runtime.open(definition)).rejects.toThrow('open failed');
	FakeWorker.openMode = 'resolve';
	await runtime.open(definition);
	expect(FakeWorker.latest?.operations).toEqual([
		{ kind: 'open' },
		{ kind: 'open' },
	]);
});

test('Account manifest owns only Account storage and never references Device', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using accountRuntime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await accountRuntime.open(definition);
	const accountManifest = FakeWorker.latest?.manifests[0];
	const accountStorageKey = accountManifest?.storageKey;
	expect(accountStorageKey).toBeString();
	expect(Object.hasOwn(accountManifest ?? {}, 'additionSourceStorageKey')).toBe(
		false,
	);

	await accountRuntime[Symbol.asyncDispose]();
	await using deviceRuntime = createRuntime();
	await deviceRuntime.open(definition);
	expect(FakeWorker.latest?.manifests[0]?.storageKey).not.toBe(
		accountStorageKey,
	);
});

test('Device capture/delete and Account add are explicit logical actions', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	let copy: Awaited<ReturnType<ReturnType<typeof createRuntime>['capture']>>;
	{
		await using device = createRuntime();
		await device.open(definition);
		copy = await device.capture(definition);
		expect(copy.rows[0]).toMatchObject({
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'Browser row' },
		});
		await device.delete(definition);
		expect(FakeWorker.latest?.operations.at(-1)).toEqual({
			kind: 'logical-delete',
		});
	}

	await using account = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await account.open(definition);
	await account.add(definition, copy);
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({
		kind: 'logical-add',
		copy,
	});
});

test('Device export reports a null settlement over the local capture', async () => {
	await using runtime = createRuntime();
	await runtime.open(definition);
	const exported = await runtime.export(definition);
	expect(exported.settlement).toBeNull();
	expect(exported.rows[0]).toMatchObject({ table: 'notes', rowId: ROW_ID });
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({
		kind: 'logical-capture',
	});
});

test('Account export settles first, then captures visible state with page documents', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	{
		using document = await workspace.tables.notes.document.open(ROW_ID);
		document.get('content').insert(0, 'export me');
		await document.whenDurable();
	}
	const exported = await runtime.export(definition);
	expect(exported.settlement).toEqual({ outcome: 'caught-up' });
	expect(exported.rows[0]?.document).toBeInstanceOf(Uint8Array);
	const kinds = FakeWorker.latest?.operations.map((operation) => operation.kind);
	expect(kinds?.indexOf('sync-settle')).toBeLessThan(
		kinds?.indexOf('capture-visible') ?? -1,
	);
});

test('Account verifyAdded gates source deletion on liveness and durability', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('verify-bob'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	const scalarCopy = {
		rows: [{ table: 'notes', rowId: ROW_ID, fields: { title: 'Browser row' } }],
		kv: {},
	};
	expect(await runtime.verifyAdded(definition, scalarCopy)).toEqual({
		outcome: 'verified',
	});

	// A copied document whose import never committed locally is not safe.
	const documentCopy = {
		rows: [
			{
				table: 'notes',
				rowId: ROW_ID,
				fields: { title: 'Browser row' },
				document: new Uint8Array([1, 2, 3]),
			},
		],
		kv: {},
	};
	expect(await runtime.verifyAdded(definition, documentCopy)).toEqual({
		outcome: 'missing',
		addresses: [{ table: 'notes', rowId: ROW_ID }],
	});
	{
		using document = await workspace.tables.notes.document.open(ROW_ID);
		document.get('content').insert(0, 'imported');
		await document.whenDurable();
	}
	expect(await runtime.verifyAdded(definition, documentCopy)).toEqual({
		outcome: 'verified',
	});

	// A row absent after settlement fails verification at that address.
	if (FakeWorker.latest) FakeWorker.latest.row = undefined;
	expect(await runtime.verifyAdded(definition, scalarCopy)).toEqual({
		outcome: 'missing',
		addresses: [{ table: 'notes', rowId: ROW_ID }],
	});
});

test('page sends list and update operations', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	await workspace.tables.notes.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
		title: 'changed',
	});
	expect(FakeWorker.latest?.operations).toEqual([
		{ kind: 'open' },
		{ kind: 'list', table: 'notes' },
		{
			kind: 'update',
			table: 'notes',
			id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			changes: { title: 'changed' },
		},
	]);
});

test('browser row documents use the page-owned IndexedDB provider', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	using document = await workspace.tables.notes.document.open(ROW_ID);
	document.get('content').insert(0, 'local');
	await document.whenDurable();
	expect(document.get('content').toString()).toBe('local');
});

test('worker transport uses the workspace record routes', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	const requests: { url: string; method: string }[] = [];
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
				async fetch(input, init) {
					requests.push({ url: String(input), method: init?.method ?? 'GET' });
					return new Response('{}', {
						status: 200,
						headers: { 'content-type': 'application/json' },
					});
				},
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	for (const action of ['push', 'pull', 'acquire'] as const) {
		FakeWorker.latest?.emit({
			type: 'transport-request',
			transportId: requests.length + 1,
			workspaceId: definition.id,
			action,
			body: {},
		});
		await Promise.resolve();
		await Promise.resolve();
	}
	expect(
		requests.map(({ url, method }) => [new URL(url).pathname, method]),
	).toEqual([
		['/api/workspaces/browser-test/records/push', 'POST'],
		['/api/workspaces/browser-test/records/pull', 'POST'],
		['/api/workspaces/browser-test/records/acquire', 'POST'],
	]);
});

test('settlement is one scalar Worker operation', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({ kind: 'sync-settle' });
});

test('Account sync status is reactive across the Worker boundary', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	const statuses: unknown[] = [];
	const unsubscribe = workspace.sync?.onStatusChange((status) => {
		statuses.push(status);
	});
	FakeWorker.latest?.emit({
		type: 'sync-status',
		workspaceId: definition.id,
		status: { phase: 'pending', reason: 'authentication' },
	});

	expect(workspace.sync?.status).toEqual({
		phase: 'pending',
		reason: 'authentication',
	});
	expect(statuses).toEqual([{ phase: 'pending', reason: 'authentication' }]);
	FakeWorker.latest?.emit({
		type: 'sync-status',
		workspaceId: definition.id,
		status: { phase: 'recovery-required', reason: 'lineage-mismatch' },
	});
	{
		using document = await workspace.tables.notes.document.open(ROW_ID);
		document.get('content').insert(0, 'recover me');
		await document.whenDurable();
	}
	const copy = await workspace.sync?.captureRecovery();
	expect(copy).toMatchObject({
		rows: [{ table: 'notes', rowId: ROW_ID }],
	});
	// The page folds its locally durable IndexedDB document state into the
	// Worker's scalar recovery copy (ADR-0142's compact document state).
	expect(copy?.rows[0]?.document).toBeInstanceOf(Uint8Array);
	unsubscribe?.();
});

test('browser transport serializes only known interruptions as retryable', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
				async fetch(input) {
					const action = new URL(String(input)).pathname.split('/').at(-1);
					switch (action) {
						case 'push':
							return Response.json({}, { status: 401 });
						case 'pull':
							return new Response('temporary proxy failure', { status: 503 });
						case 'acquire':
							return Response.json({}, { status: 400 });
						default:
							throw new Error('Unexpected action');
					}
				},
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await runtime.open(definition);
	const actions = ['push', 'pull', 'acquire'] as const;
	for (const action of actions) {
		FakeWorker.latest?.emit({
			type: 'transport-request',
			transportId: FakeWorker.latest.transportResponses.length + 1,
			workspaceId: definition.id,
			action,
			body: {},
		});
		await waitFor(
			() =>
				(FakeWorker.latest?.transportResponses.length ?? 0) >
				actions.indexOf(action),
		);
	}

	expect(FakeWorker.latest?.transportResponses).toMatchObject([
		{ type: 'transport-error', pendingReason: 'authentication' },
		{ type: 'transport-error', pendingReason: 'retrying' },
		{ type: 'transport-error' },
	]);
	expect(FakeWorker.latest?.transportResponses[2]).not.toHaveProperty(
		'pendingReason',
	);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for browser');
		await Bun.sleep(5);
	}
}
