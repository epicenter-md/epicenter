/**
 * HTTP Document Protocol Tests
 *
 * Covers what this package owns after the sockets-to-HTTP reduction: the
 * document size bounds, and the one route's mapping from HTTP answers onto the
 * publish/pull unions.
 *
 * Key behaviors:
 * - a bound is exceeded by either dimension independently; at the limit is fine
 * - the transfer ceiling admits a valid V2 re-encoding of in-bound state
 * - each address coordinate is its own percent-encoded path segment
 * - conditional and refusal statuses map to outcomes; other failures throw
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import {
	createHttpDocumentTransports,
	DOCUMENT_BOUND,
	DOCUMENT_MAX_TRANSFER_BYTES,
	exceedsDocumentBound,
	measureDocumentState,
} from './protocol.js';

const address = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	tableName: 'notes',
	rowId: 'row-1',
} as const;

/** Capture the one request a transport makes, and answer it with `response`. */
function stubFetch(response: Response) {
	const calls: { url: URL; init: RequestInit }[] = [];
	return {
		calls,
		fetch: async (url: URL, init: RequestInit) => {
			calls.push({ url, init });
			return response;
		},
	};
}

describe('document bounds', () => {
	test('measures real V2 state as bytes and struct count', () => {
		const doc = new Y.Doc();
		doc.get('draft').insert(0, 'hello');
		const encoded = Y.encodeStateAsUpdateV2(doc);

		const measure = measureDocumentState(encoded);

		expect(measure.stateBytes).toBe(encoded.byteLength);
		expect(measure.stateStructs).toBe(Y.decodeUpdateV2(encoded).structs.length);
		expect(measure.stateStructs).toBeGreaterThan(0);
	});

	test('either dimension alone exceeds the bound, and the limit itself does not', () => {
		const atLimit = {
			stateBytes: DOCUMENT_BOUND.stateBytes,
			stateStructs: DOCUMENT_BOUND.stateStructs,
		};

		expect(exceedsDocumentBound(atLimit)).toBe(false);
		expect(
			exceedsDocumentBound({ ...atLimit, stateBytes: atLimit.stateBytes + 1 }),
		).toBe(true);
		expect(
			exceedsDocumentBound({
				...atLimit,
				stateStructs: atLimit.stateStructs + 1,
			}),
		).toBe(true);
	});

	test('the transfer ceiling leaves room for a re-encoding of in-bound state', () => {
		// The authority still enforces the canonical bound on post-candidate
		// state; the envelope is deliberately looser than what it will accept.
		expect(DOCUMENT_MAX_TRANSFER_BYTES).toBe(2 * DOCUMENT_BOUND.stateBytes);
		expect(DOCUMENT_MAX_TRANSFER_BYTES).toBeGreaterThan(
			DOCUMENT_BOUND.stateBytes,
		);
	});
});

describe('publishDocument', () => {
	test('addresses one row by coordinate segments and posts the update body', async () => {
		const stub = stubFetch(Response.json({ outcome: 'accepted' }));
		const { publishDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test/ignored?query#hash',
			fetch: stub.fetch,
		});

		const update = new Uint8Array([1, 2, 3]);
		expect(await publishDocument({ address, update })).toBe('accepted');

		const [call] = stub.calls;
		expect(call?.url.pathname).toBe(
			'/api/sync/v1/documents/so.epicenter.notes/notes/row-1',
		);
		expect(call?.url.search).toBe('');
		expect(call?.url.hash).toBe('');
		expect(call?.init.method).toBe('POST');
		expect(new Uint8Array(call?.init.body as ArrayBuffer)).toEqual(update);
	});

	test('percent-encodes every coordinate rather than trusting the grammar', async () => {
		const stub = stubFetch(Response.json({ outcome: 'accepted' }));
		const { publishDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		await publishDocument({
			address: { ...address, rowId: 'a/b c' },
			update: new Uint8Array(),
		});

		expect(stub.calls[0]?.url.pathname).toBe(
			'/api/sync/v1/documents/so.epicenter.notes/notes/a%2Fb%20c',
		);
	});

	test('reports a body over the transport ceiling as a terminal refusal', async () => {
		const stub = stubFetch(new Response(null, { status: 413 }));
		const { publishDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		// Terminal, not thrown: retrying this lineage can never succeed.
		expect(await publishDocument({ address, update: new Uint8Array() })).toBe(
			'too-large',
		);
	});

	test('throws on server failure so the drain backs off and retries', async () => {
		const stub = stubFetch(new Response(null, { status: 503 }));
		const { publishDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		await expect(
			publishDocument({ address, update: new Uint8Array() }),
		).rejects.toThrow('(503)');
	});

	test('refuses an unrecognized publish outcome', async () => {
		const stub = stubFetch(Response.json({ outcome: 'maybe' }));
		const { publishDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		await expect(
			publishDocument({ address, update: new Uint8Array() }),
		).rejects.toThrow('Invalid document publish response');
	});
});

describe('pullDocument', () => {
	test('sends the known version as a conditional request and reads unchanged', async () => {
		const stub = stubFetch(new Response(null, { status: 304 }));
		const { pullDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		expect(await pullDocument({ address, sinceVersion: 'v1' })).toEqual({
			kind: 'unchanged',
		});
		expect(stub.calls[0]?.init.method).toBe('GET');
		expect(stub.calls[0]?.init.headers).toEqual({ 'if-none-match': 'v1' });
	});

	test('omits the conditional header when no version is known', async () => {
		const stub = stubFetch(new Response(null, { status: 204 }));
		const { pullDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		expect(await pullDocument({ address, sinceVersion: undefined })).toEqual({
			kind: 'unchanged',
		});
		expect(stub.calls[0]?.init.headers).toEqual({});
	});

	test('reports an absent document as not-live', async () => {
		const stub = stubFetch(new Response(null, { status: 404 }));
		const { pullDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		expect(await pullDocument({ address, sinceVersion: undefined })).toEqual({
			kind: 'not-live',
		});
	});

	test('returns versioned state carrying the encoded update', async () => {
		const doc = new Y.Doc();
		doc.get('draft').insert(0, 'hello');
		const update = Y.encodeStateAsUpdateV2(doc);
		const stub = stubFetch(
			new Response(update.slice().buffer as ArrayBuffer, {
				status: 200,
				headers: { etag: 'v7' },
			}),
		);
		const { pullDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		expect(await pullDocument({ address, sinceVersion: undefined })).toEqual({
			kind: 'state',
			version: 'v7',
			update,
		});
	});

	test('refuses state with no version to settle against', async () => {
		const stub = stubFetch(new Response(new ArrayBuffer(0), { status: 200 }));
		const { pullDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		await expect(
			pullDocument({ address, sinceVersion: undefined }),
		).rejects.toThrow('has no version');
	});

	test('throws on server failure', async () => {
		const stub = stubFetch(new Response(null, { status: 500 }));
		const { pullDocument } = createHttpDocumentTransports({
			baseUrl: 'https://api.example.test',
			fetch: stub.fetch,
		});

		await expect(
			pullDocument({ address, sinceVersion: undefined }),
		).rejects.toThrow('(500)');
	});
});
