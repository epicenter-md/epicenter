import { expect, test } from 'bun:test';
import { ReplicaSyncRefusalError } from './replica.js';
import { createHttpReplicaSyncPort } from './replica-http.js';

test('HTTP replica port binds one encoded workspace and forwards exact JSON', async () => {
	const requests: { url: string; body: unknown; signal: AbortSignal | null }[] =
		[];
	const port = createHttpReplicaSyncPort({
		baseUrl: 'https://api.example.test/base',
		async fetch(input, init) {
			requests.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
				signal: init?.signal ?? null,
			});
			return Response.json(
				requests.length === 1
					? { recordsEpoch: 'epoch-1', recordsSchemaHash: 'schema-1' }
					: { kind: 'push', ok: true },
			);
		},
	});
	const controller = new AbortController();

	expect(
		await port.openAuthority(
			{
				workspaceId: 'notes/2026',
				protocolMajor: 1,
				recordsSchemaHash: 'schema-1',
			},
			controller.signal,
		),
	).toEqual({ recordsEpoch: 'epoch-1', recordsSchemaHash: 'schema-1' });
	await port.push(
		{
			kind: 'push',
			protocolMajor: 1,
			recordsSchemaHash: 'schema-1',
			recordsEpoch: 'epoch-1',
			mutations: [],
		},
		controller.signal,
	);

	expect(requests).toEqual([
		{
			url: 'https://api.example.test/api/records/notes%2F2026/open',
			body: { protocolMajor: 1, recordsSchemaHash: 'schema-1' },
			signal: controller.signal,
		},
		{
			url: 'https://api.example.test/api/records/notes%2F2026/push',
			body: {
				kind: 'push',
				protocolMajor: 1,
				recordsSchemaHash: 'schema-1',
				recordsEpoch: 'epoch-1',
				mutations: [],
			},
			signal: controller.signal,
		},
	]);
	await expect(
		port.openAuthority({
			workspaceId: 'other',
			protocolMajor: 1,
			recordsSchemaHash: 'schema-1',
		}),
	).rejects.toThrow('already bound');
});

test('HTTP replica port reports non-success and malformed responses', async () => {
	const responses = [
		new Response('unavailable', { status: 503 }),
		new Response('not json', { status: 200 }),
	];
	const port = createHttpReplicaSyncPort({
		baseUrl: 'https://api.example.test',
		async fetch() {
			return responses.shift() ?? Response.json({});
		},
	});

	await expect(
		port.openAuthority({
			workspaceId: 'notes',
			protocolMajor: 1,
			recordsSchemaHash: 'schema-1',
		}),
	).rejects.toThrow('non-JSON HTTP 503');
	await expect(
		port.openAuthority({
			workspaceId: 'notes',
			protocolMajor: 1,
			recordsSchemaHash: 'schema-1',
		}),
	).rejects.toThrow('non-JSON HTTP 200');
});

test('HTTP protocol mismatch remains a terminal replica refusal', async () => {
	const port = createHttpReplicaSyncPort({
		baseUrl: 'https://api.example.test',
		async fetch() {
			return Response.json(
				{
					error: {
						name: 'ProtocolMismatch',
						message: 'The record synchronization protocol is incompatible.',
						status: 409,
					},
				},
				{ status: 409 },
			);
		},
	});

	await expect(
		port.openAuthority({
			workspaceId: 'notes',
			protocolMajor: 3,
			recordsSchemaHash: 'schema-1',
		}),
	).rejects.toBeInstanceOf(ReplicaSyncRefusalError);
});
