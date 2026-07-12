import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type {
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './client.js';
import { defineTable, defineWorkspace } from './definition.js';
import {
	type OwnedWorkspaceServicePort,
	openWorkspaceFromService,
} from './open.js';

function setup() {
	const definition = defineWorkspace({
		id: 'open-test',
		name: 'Open test',
		epoch: 'open-test-v1',
		tables: { notes: defineTable({ id: field.string() }) },
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
				schemaIdentity: definition.schemaIdentity,
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
				schemaIdentity: definition.schemaIdentity,
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
				schemaIdentity: 'different',
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
