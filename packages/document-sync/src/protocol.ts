import type {
	DocumentPublishOutcome,
	PublishDocument,
	PullDocument,
	RowAddress,
} from '@epicenter/data/legacy';
import * as Y from '@y/y';

export type { RowAddress } from '@epicenter/data/legacy';

export const DOCUMENT_BOUND = {
	stateBytes: 1_048_576,
	stateStructs: 131_072,
} as const;

/**
 * The transport body ceiling for one document publication or pull. A valid V2
 * encoding of in-bound state can exceed the canonical state size, so the
 * envelope allows twice the canonical byte bound; the authority still
 * enforces the canonical bound on the post-candidate state.
 */
export const DOCUMENT_MAX_TRANSFER_BYTES = 2 * DOCUMENT_BOUND.stateBytes;

export function measureDocumentState(encoded: Uint8Array): {
	stateBytes: number;
	stateStructs: number;
} {
	return {
		stateBytes: encoded.byteLength,
		stateStructs: Y.decodeUpdateV2(encoded).structs.length,
	};
}

export function exceedsDocumentBound(measure: {
	stateBytes: number;
	stateStructs: number;
}): boolean {
	return (
		measure.stateBytes > DOCUMENT_BOUND.stateBytes ||
		measure.stateStructs > DOCUMENT_BOUND.stateStructs
	);
}

/**
 * The one HTTP route for a row document: POST publishes, GET pulls.
 *
 * Each address coordinate is its own path segment, so no joined key is ever
 * built or parsed. Every segment is percent-encoded even though the address
 * grammar admits only URL-safe characters, because escaping is the transport's
 * job and must not depend on the grammar staying narrow.
 */
function documentSyncUrl({
	baseUrl,
	address,
}: {
	baseUrl: string | URL;
	address: RowAddress;
}): URL {
	const url = new URL(baseUrl);
	const segments = [address.namespace, address.tableName, address.rowId].map(
		(segment) => encodeURIComponent(segment),
	);
	url.pathname = `/api/sync/v1/documents/${segments.join('/')}`;
	url.search = '';
	url.hash = '';
	return url;
}

function parseDocumentPublishOutcome(value: unknown): DocumentPublishOutcome {
	if (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		'outcome' in value &&
		((value as { outcome: unknown }).outcome === 'accepted' ||
			(value as { outcome: unknown }).outcome === 'not-live' ||
			(value as { outcome: unknown }).outcome === 'too-large')
	) {
		return (value as { outcome: DocumentPublishOutcome }).outcome;
	}
	throw new TypeError('Invalid document publish response');
}

/**
 * Build both document transports over one authenticated fetch. The publish
 * transport throws on transport or server failure so the drain backs off and
 * retries reconstructed current state; the pull transport maps conditional
 * HTTP answers onto the pull response union.
 */
export function createHttpDocumentTransports({
	baseUrl,
	fetch: authorizedFetch,
}: {
	baseUrl: string | URL;
	fetch: (url: URL, init: RequestInit) => Promise<Response>;
}): { publishDocument: PublishDocument; pullDocument: PullDocument } {
	return {
		async publishDocument({ address, update }) {
			const response = await authorizedFetch(
				documentSyncUrl({ baseUrl, address }),
				{
					method: 'POST',
					headers: { 'content-type': 'application/octet-stream' },
					// Copy into a plain ArrayBuffer: the DOM BodyInit type refuses a
					// Uint8Array over ArrayBufferLike.
					body: update.slice().buffer as ArrayBuffer,
				},
			);
			// A body the transport ceiling will never admit is the same terminal
			// resource refusal as the authority's canonical bound: retrying the
			// lineage cannot succeed, so it records the durable too-large issue.
			if (response.status === 413) return 'too-large';
			if (!response.ok) {
				throw new Error(
					`Epicenter document publication failed (${response.status})`,
				);
			}
			return parseDocumentPublishOutcome(await response.json());
		},
		async pullDocument({ address, sinceVersion }) {
			const response = await authorizedFetch(
				documentSyncUrl({ baseUrl, address }),
				{
					method: 'GET',
					headers:
						sinceVersion === undefined ? {} : { 'if-none-match': sinceVersion },
				},
			);
			if (response.status === 304) return { kind: 'unchanged' };
			if (response.status === 404) return { kind: 'not-live' };
			if (!response.ok) {
				throw new Error(`Epicenter document pull failed (${response.status})`);
			}
			if (response.status === 204) return { kind: 'unchanged' };
			const version = response.headers.get('etag');
			if (version === null) {
				throw new Error('Epicenter document pull response has no version');
			}
			return {
				kind: 'state',
				version,
				update: new Uint8Array(await response.arrayBuffer()),
			};
		},
	};
}
