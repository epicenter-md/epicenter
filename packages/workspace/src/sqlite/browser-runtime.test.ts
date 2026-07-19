/**
 * Browser Workspace Runtime Tests
 *
 * Verifies the page-side Worker protocol without opening OPFS.
 *
 * Key behaviors:
 * - open resolves only with a ready, stable handle; failure rejects terminally
 * - list and update use the public row verbs
 * - KV observation re-reads changed values and detaches cleanly
 * - current-state transport actions cross the boundary
 */

import { afterEach, expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { Type } from 'typebox';
import {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from './browser-runtime.js';
import {
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	isWorkspaceStorageHeldError,
} from './browser-runtime-protocol.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './workspace-lens.js';

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
	theme: unknown = 'light';
	sqlRows: Record<string, unknown>[] = [];
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
					// Mirrors the real Worker's terminal acquisition failure: the
					// named held-storage contract crossing the message boundary.
					this.emit({
						type: 'error',
						id: message.id,
						name: 'WorkspaceStorageHeldError',
						message: 'Workspace storage is held by another tab or window',
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
				case 'list-current-rows':
					return this.row === undefined
						? []
						: [{ rowId: ROW_ID, fields: this.row }];
				case 'kv-read-map':
					return this.theme === undefined ? {} : { theme: this.theme };
				case 'admit-intent': {
					const { intent } = message.operation;
					if (intent.table === RESERVED_KV_TABLE) {
						if (intent.kind === 'update') {
							if (intent.fields.unset.includes('theme')) this.theme = undefined;
							if ('theme' in intent.fields.set) {
								this.theme = intent.fields.set.theme as 'light' | 'dark';
							}
						}
						return undefined;
					}
					if (intent.kind === 'delete') this.row = undefined;
					if (intent.kind === 'create') this.row = intent.fields;
					if (intent.kind === 'update' && this.row) {
						this.row = { ...this.row, ...intent.fields.set };
						for (const key of intent.fields.unset) delete this.row[key];
					}
					return undefined;
				}
				case 'sql':
					return this.sqlRows;
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

test('open resolves only with a ready handle and reopening is stable', async () => {
	FakeWorker.openMode = 'defer';
	await using runtime = createRuntime();
	let ready = false;
	const opening = runtime.open(definition).then((handle) => {
		ready = true;
		return handle;
	});
	// Reopening before readiness shares the one storage-opening attempt.
	expect(runtime.open(definition)).toBe(runtime.open(definition));
	await Promise.resolve();
	await Promise.resolve();
	expect(ready).toBe(false);
	expect(FakeWorker.latest?.operations[0]).toEqual({ kind: 'open' });
	FakeWorker.latest?.resolveOpen();
	const workspace = await opening;
	await workspace.tables.notes.list();
	// The handle is stable: reopening resolves the same object.
	expect(await runtime.open(definition)).toBe(workspace);
	expect(
		FakeWorker.latest?.operations.filter(({ kind }) => kind === 'open'),
	).toEqual([{ kind: 'open' }]);
});

test('failed acquisition is terminal: open rejects and never retries', async () => {
	FakeWorker.openMode = 'reject';
	await using runtime = createRuntime();
	const failure = await runtime.open(definition).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(failure).toBeInstanceOf(Error);
	expect(isWorkspaceStorageHeldError(failure)).toBe(true);
	// The same terminal rejection, with no second acquisition attempt behind
	// a later open.
	await expect(runtime.open(definition)).rejects.toThrow('held by another tab');
	expect(
		FakeWorker.latest?.operations.filter(({ kind }) => kind === 'open'),
	).toEqual([{ kind: 'open' }]);
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
	await account.add(definition, copy);
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({
		kind: 'logical-add',
		copy,
	});
});

test('Device export reports a null settlement over the local capture', async () => {
	await using runtime = createRuntime();
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
	const kinds = FakeWorker.latest?.operations.map(
		(operation) => operation.kind,
	);
	expect(kinds?.indexOf('sync-settle')).toBeLessThan(
		kinds?.indexOf('capture-visible') ?? -1,
	);
});

test('page sends raw list, read, and intent operations', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	await workspace.tables.notes.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
		title: 'changed',
	});
	expect(FakeWorker.latest?.operations).toEqual([
		{ kind: 'open' },
		{ kind: 'list-current-rows', table: 'notes' },
		{
			kind: 'read-current-row',
			table: 'notes',
			rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		},
		{
			kind: 'admit-intent',
			intent: {
				kind: 'update',
				table: 'notes',
				rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				fields: { set: { title: 'changed' }, unset: [] },
			},
		},
		{
			kind: 'read-current-row',
			table: 'notes',
			rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		},
	]);
});

test('same workspace ID supports divergent page-local lenses over one owner', async () => {
	await using runtime = createRuntime();
	const recordingLens = defineWorkspace({
		id: definition.id,
		tables: {
			notes: defineTable({
				fields: { title: field.string(), archived: field.boolean() },
				optional: ['archived'],
			}),
		},
	});
	const honeycrisp = await runtime.open(definition);
	const recording = await runtime.open(recordingLens);
	expect(honeycrisp).not.toBe(recording);
	expect(await runtime.open(definition)).toBe(honeycrisp);
	expect(await runtime.open(recordingLens)).toBe(recording);
	expect(
		FakeWorker.latest?.operations.filter(({ kind }) => kind === 'open'),
	).toEqual([{ kind: 'open' }]);
	expect(FakeWorker.latest?.manifests[0]).toEqual({
		workspaceId: definition.id,
		storageKey: expect.any(String),
	});
});

test('row and SQL conformance are checked only in the page realm', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	if (!FakeWorker.latest) throw new Error('Expected fake Worker');
	FakeWorker.latest.row = { title: 42 };
	const row = await workspace.tables.notes.get(ROW_ID);
	expect(row.error).not.toBeNull();
	const listed = await workspace.tables.notes.list();
	expect(listed.rows).toEqual([]);
	expect(listed.nonconforming).toHaveLength(1);

	FakeWorker.latest.sqlRows = [{ title: 42 }];
	await expect(
		workspace.sql(
			'SELECT title FROM records',
			[],
			Type.Object({ title: Type.String() }),
		),
	).rejects.toThrow('SQL row 0 does not satisfy the result schema');
	const sqlOperation = FakeWorker.latest.operations.at(-1);
	expect(sqlOperation).toEqual({
		kind: 'sql',
		query: 'SELECT title FROM records',
		parameters: [],
	});
	expect(sqlOperation).not.toHaveProperty('resultSchema');
});

test('KV conformance is checked in the page realm over one raw map', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	if (!FakeWorker.latest) throw new Error('Expected fake Worker');
	FakeWorker.latest.theme = 42;
	const value = await workspace.kv.get('theme');
	expect(value.error).not.toBeNull();
	expect(FakeWorker.latest.operations.at(-1)).toEqual({ kind: 'kv-read-map' });
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
