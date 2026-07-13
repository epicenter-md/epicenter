import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import * as Y from 'yjs';
import type {
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './client.js';
import { defineKv, defineTable, defineWorkspace } from './definition.js';
import { document } from './document-format.js';
import {
	type DocumentReference,
	historicalDocument,
} from './document-reference.js';
import {
	type OwnedWorkspaceServicePort,
	openWorkspaceFromService,
} from './open.js';

function setup() {
	const definition = defineWorkspace({
		id: 'open-test',
		name: 'Open test',
		tables: { notes: defineTable({ fields: { id: field.string() } }) },
	});
	let disposed = 0;
	const requests: WorkspaceServiceRequest[] = [];
	const service: OwnedWorkspaceServicePort = {
		async request(request): Promise<WorkspaceServiceResponse> {
			requests.push(request);
			return {
				kind: 'workspace',
				workspaceKind: 'standalone',
				workspaceId: definition.id,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		observe() {
			return () => undefined;
		},
		async [Symbol.asyncDispose]() {
			disposed++;
		},
	};
	return { definition, service, requests, disposed: () => disposed };
}

test('standalone workspace verifies its service before exposing the typed client', async () => {
	const { definition, service, requests, disposed } = setup();
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
	});

	expect(workspace.kind).toBe('standalone');
	expect(requests).toEqual([{ kind: 'describe' }]);
	await workspace[Symbol.asyncDispose]();
	await workspace[Symbol.asyncDispose]();
	expect(disposed()).toBe(1);
	await expect(workspace.tables.notes.count()).rejects.toThrow('disposed');
});

test('shared service opener preserves the replica lifecycle kind', async () => {
	const { definition, service } = setup();
	const replicaService: OwnedWorkspaceServicePort = {
		...service,
		async request(request) {
			if (request.kind !== 'describe') return service.request(request);
			return {
				kind: 'workspace',
				workspaceKind: 'replica',
				workspaceId: definition.id,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
	};
	const replica = await openWorkspaceFromService(definition, {
		service: replicaService,
		expectedKind: 'replica',
	});

	expect(replica.kind).toBe('replica');
	await replica[Symbol.asyncDispose]();
});

test('standalone workspace disposes a mismatched service and refuses to open', async () => {
	const { definition, service, disposed } = setup();
	const mismatched: OwnedWorkspaceServicePort = {
		...service,
		async request() {
			return {
				kind: 'workspace',
				workspaceKind: 'standalone',
				workspaceId: definition.id,
				recordsSchemaHash: 'different',
			};
		},
	};

	await expect(
		openWorkspaceFromService(definition, {
			service: mismatched,
			expectedKind: 'standalone',
		}),
	).rejects.toThrow('does not match');
	expect(disposed()).toBe(1);
});

test('standalone workspace disposes a service whose handshake fails', async () => {
	const { definition, service, disposed } = setup();
	const failed: OwnedWorkspaceServicePort = {
		...service,
		async request() {
			throw new Error('worker failed');
		},
	};

	await expect(
		openWorkspaceFromService(definition, {
			service: failed,
			expectedKind: 'standalone',
		}),
	).rejects.toThrow('worker failed');
	expect(disposed()).toBe(1);
});

test('standalone workspace preserves handshake failure when cleanup also fails', async () => {
	const { definition, service } = setup();
	const failed: OwnedWorkspaceServicePort = {
		...service,
		async request() {
			throw new Error('handshake failed');
		},
		async [Symbol.asyncDispose]() {
			throw new Error('cleanup failed');
		},
	};

	try {
		await openWorkspaceFromService(definition, {
			service: failed,
			expectedKind: 'standalone',
		});
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).cause).toEqual(
			new Error('handshake failed'),
		);
	}
});

test('standalone workspace settles admitted work while rejecting new work during disposal', async () => {
	const { definition, service } = setup();
	let resolveCount!: (response: WorkspaceServiceResponse) => void;
	let resolveDisposal!: () => void;
	const delayed: OwnedWorkspaceServicePort = {
		...service,
		request(request) {
			if (request.kind === 'describe') return service.request(request);
			return new Promise((resolve) => {
				resolveCount = resolve;
			});
		},
		[Symbol.asyncDispose]() {
			return new Promise((resolve) => {
				resolveDisposal = resolve;
			});
		},
	};
	const workspace = await openWorkspaceFromService(definition, {
		service: delayed,
		expectedKind: 'standalone',
	});
	const count = workspace.tables.notes.count();
	const disposal = workspace[Symbol.asyncDispose]();
	await expect(workspace.tables.notes.count()).rejects.toThrow('disposed');
	resolveCount({ kind: 'count', value: 1 });
	expect(await count).toBe(1);
	resolveDisposal();
	await disposal;

	await expect(workspace.tables.notes.count()).rejects.toThrow('disposed');
});

function setupWithKv() {
	const definition = defineWorkspace({
		id: 'open-kv-test',
		name: 'Open KV test',
		tables: { notes: defineTable({ fields: { id: field.string() } }) },
		kv: {
			theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
		},
	});
	const service: OwnedWorkspaceServicePort = {
		async request(): Promise<WorkspaceServiceResponse> {
			return {
				kind: 'workspace',
				workspaceKind: 'standalone',
				workspaceId: definition.id,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		observe() {
			return () => undefined;
		},
		async [Symbol.asyncDispose]() {},
	};
	return { definition, service };
}

test('table-only workspaces expose no kv handle', async () => {
	const { definition, service } = setup();
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
	});

	expect(workspace.kv).toBeUndefined();
	await workspace[Symbol.asyncDispose]();
});

test('composed kv is a synchronous preference plane over the caller root document', async () => {
	const { definition, service } = setupWithKv();
	const doc = new Y.Doc();
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		kv: { doc },
	});

	// Reads are synchronous: absent reads as a fresh default.
	expect(workspace.kv.get('theme')).toBe('light');

	const changes: unknown[] = [];
	const stopObserving = workspace.kv.observe('theme', (change) =>
		changes.push(change),
	);
	workspace.kv.set('theme', 'dark');
	expect(workspace.kv.get('theme')).toBe('dark');
	expect(changes).toEqual([{ type: 'set', value: 'dark' }]);
	stopObserving();

	// The stored bytes live in the root document's kv namespace, so a second
	// mount over the same doc sees the same preference.
	const entries = doc
		.getArray<{ key: string; val: unknown }>('kv')
		.toArray()
		.map(({ key, val }) => ({ key, val }));
	expect(entries).toEqual([{ key: 'theme', val: 'dark' }]);

	// Workspace disposal owns the service; the document stays caller-owned.
	await workspace[Symbol.asyncDispose]();
	expect(workspace.kv.get('theme')).toBe('dark');
	doc.destroy();
});

test('kv hydration is awaited before the workspace opens', async () => {
	const { definition, service } = setupWithKv();
	const doc = new Y.Doc();
	let hydrate!: () => void;
	const whenHydrated = new Promise<void>((resolve) => {
		hydrate = resolve;
	});
	let opened = false;
	const opening = openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		kv: { doc, whenHydrated },
	}).then((workspace) => {
		opened = true;
		return workspace;
	});

	await Promise.resolve();
	await Promise.resolve();
	expect(opened).toBe(false);

	// Hydration lands a persisted preference before the workspace opens, so
	// the first read never reports the default in place of durable state.
	doc
		.getArray<{ key: string; val: unknown; ts: number }>('kv')
		.push([{ key: 'theme', val: 'dark', ts: 1 }]);
	hydrate();
	const workspace = await opening;
	expect(opened).toBe(true);
	expect(workspace.kv.get('theme')).toBe('dark');
	await workspace[Symbol.asyncDispose]();
	doc.destroy();
});

test('a rejected kv hydration disposes the service and refuses to open', async () => {
	const { definition, service } = setupWithKv();
	let disposed = 0;
	const countingService: OwnedWorkspaceServicePort = {
		...service,
		async [Symbol.asyncDispose]() {
			disposed++;
		},
	};
	const doc = new Y.Doc();

	await expect(
		openWorkspaceFromService(definition, {
			service: countingService,
			expectedKind: 'standalone',
			kv: { doc, whenHydrated: Promise.reject(new Error('hydration failed')) },
		}),
	).rejects.toThrow('hydration failed');
	expect(disposed).toBe(1);
	doc.destroy();
});

test('document runtime opens retained historical and current format endpoints explicitly', async () => {
	const definition = defineWorkspace({
		id: 'document-conversion-test',
		tables: {
			recordings: defineTable({
				fields: { id: field.string(), transcript: field.string() },
				documents: { transcript: document.xmlFragment },
			}),
		},
	});
	const service: OwnedWorkspaceServicePort = {
		async request(): Promise<WorkspaceServiceResponse> {
			return {
				kind: 'workspace',
				workspaceKind: 'standalone',
				workspaceId: definition.id,
				recordsSchemaHash: definition.recordsSchemaHash,
			};
		},
		observe() {
			return () => undefined;
		},
		async [Symbol.asyncDispose]() {},
	};
	const disposed: string[] = [];
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		documents: {
			open(guid) {
				const doc = new Y.Doc({ guid });
				return {
					doc,
					whenReady: Promise.resolve(),
					[Symbol.dispose]() {
						disposed.push(guid);
						doc.destroy();
					},
				};
			},
		},
	});
	const previousTranscript = historicalDocument({
		workspaceId: definition.id,
		table: 'recordings',
		document: 'transcript',
		format: document.plainText,
	});
	const rowId = 'Imported/Recording.日本語';
	const source = workspace.documents.open(previousTranscript, rowId);
	const target = workspace.tables.recordings.docs.transcript.open(rowId);
	await Promise.all([source.whenReady, target.whenReady]);

	source.content.write('retained transcript');
	target.content.write(source.content.read());

	expect(target.content.read()).toBe('retained transcript');
	expect(source.guid).not.toBe(target.guid);
	expect(source.guid.split('.')).toHaveLength(5);
	expect(target.guid.split('.')).toHaveLength(5);

	source[Symbol.dispose]();
	source[Symbol.dispose]();
	target[Symbol.dispose]();
	expect(disposed).toEqual([source.guid, target.guid]);
	await workspace[Symbol.asyncDispose]();
	expect(() => workspace.tables.recordings.docs.transcript.open(rowId)).toThrow(
		'Workspace is disposed',
	);
	expect(disposed).toEqual([source.guid, target.guid]);
});

test('a document readiness failure disposes its runtime session', async () => {
	const { definition, service } = setup();
	let disposed = 0;
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		documents: {
			open(guid) {
				return {
					doc: new Y.Doc({ guid }),
					whenReady: Promise.reject(new Error('document hydration failed')),
					[Symbol.dispose]() {
						disposed++;
					},
				};
			},
		},
	});
	const reference = historicalDocument({
		workspaceId: definition.id,
		table: 'notes',
		document: 'body',
		format: document.plainText,
	});
	const opened = workspace.documents.open(reference, 'note-1');

	await expect(opened.whenReady).rejects.toThrow('document hydration failed');
	expect(disposed).toBe(1);
	opened[Symbol.dispose]();
	expect(disposed).toBe(1);
	const manuallyDisposed = workspace.documents.open(reference, 'note-2');
	manuallyDisposed[Symbol.dispose]();
	await expect(manuallyDisposed.whenReady).rejects.toThrow(
		'document hydration failed',
	);
	expect(disposed).toBe(2);
	await workspace[Symbol.asyncDispose]();
});

test('unknown references and wrong runtime rooms fail before exposing a handle', async () => {
	const { definition, service } = setup();
	let runtimeOpens = 0;
	let disposed = 0;
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		documents: {
			open(guid) {
				runtimeOpens++;
				return {
					doc: new Y.Doc({ guid: `${guid}-wrong` }),
					[Symbol.dispose]() {
						disposed++;
					},
				};
			},
		},
	});
	const forged = {} as DocumentReference<typeof document.plainText>;
	expect(() => workspace.documents.open(forged, 'note-1')).toThrow(
		'Unknown document reference',
	);
	expect(runtimeOpens).toBe(0);

	const reference = historicalDocument({
		workspaceId: definition.id,
		table: 'notes',
		document: 'body',
		format: document.plainText,
	});
	expect(() => workspace.documents.open(reference, 'note-1')).toThrow(
		'for requested room',
	);
	expect(runtimeOpens).toBe(1);
	expect(disposed).toBe(1);
	await workspace[Symbol.asyncDispose]();
});

test('document open preserves primary and session-cleanup failures', async () => {
	const { definition, service } = setup();
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		documents: {
			open(guid) {
				return {
					doc: new Y.Doc({ guid: `${guid}-wrong` }),
					[Symbol.dispose]() {
						throw new Error('session cleanup failed');
					},
				};
			},
		},
	});
	const reference = historicalDocument({
		workspaceId: definition.id,
		table: 'notes',
		document: 'body',
		format: document.plainText,
	});

	let failure: unknown;
	try {
		workspace.documents.open(reference, 'note-1');
	} catch (cause) {
		failure = cause;
	}
	expect(failure).toBeInstanceOf(AggregateError);
	const aggregate = failure as AggregateError;
	expect(aggregate.cause).toBeInstanceOf(Error);
	expect((aggregate.cause as Error).message).toContain('for requested room');
	expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
		expect.stringContaining('for requested room'),
		'session cleanup failed',
	]);
	await workspace[Symbol.asyncDispose]();
});

test('historical document references cannot cross workspace families', async () => {
	const { definition, service } = setup();
	let runtimeOpens = 0;
	const workspace = await openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
		documents: {
			open(guid) {
				runtimeOpens++;
				const doc = new Y.Doc({ guid });
				return { doc, [Symbol.dispose]: () => doc.destroy() };
			},
		},
	});
	const foreign = historicalDocument({
		workspaceId: 'another-workspace',
		table: 'notes',
		document: 'body',
		format: document.plainText,
	});

	expect(() => workspace.documents.open(foreign, 'note-1')).toThrow(
		"belongs to workspace 'another-workspace'",
	);
	expect(runtimeOpens).toBe(0);
	await workspace[Symbol.asyncDispose]();
});
