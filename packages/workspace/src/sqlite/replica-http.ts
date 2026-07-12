import type { RecordAuthorityBindingRequest } from '@epicenter/record-sync';
import type {
	ReplicaDatabaseBindingRequest,
	ReplicaSyncPort,
} from './replica.js';

export type CreateHttpReplicaSyncPortOptions = {
	baseUrl: string;
	/** Auth-owned fetch implementation. */
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

/** Bind the record-sync HTTP routes to one workspace replica runtime. */
export function createHttpReplicaSyncPort({
	baseUrl,
	fetch,
}: CreateHttpReplicaSyncPortOptions): ReplicaSyncPort {
	const origin = new URL(baseUrl);
	let workspaceId: string | undefined;

	function route(action: string): URL {
		if (!workspaceId) {
			throw new Error('Replica HTTP port has not opened a workspace database');
		}
		return new URL(
			`/api/records/${encodeURIComponent(workspaceId)}/${action}`,
			origin,
		);
	}

	async function post(
		url: URL,
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		const text = await response.text();
		let value: unknown;
		try {
			value = text === '' ? null : JSON.parse(text);
		} catch (cause) {
			throw new Error(`Record sync returned non-JSON HTTP ${response.status}`, {
				cause,
			});
		}
		if (!response.ok) {
			throw new Error(`Record sync HTTP ${response.status}: ${text}`);
		}
		return value;
	}

	return {
		bindWorkspace(nextWorkspaceId) {
			if (workspaceId && workspaceId !== nextWorkspaceId) {
				throw new Error(
					'Replica HTTP port is already bound to another workspace',
				);
			}
			workspaceId = nextWorkspaceId;
		},
		async openDatabase(request, signal) {
			this.bindWorkspace(request.workspaceId);
			return post(route('open'), openRequestBody(request), signal);
		},
		push(request, signal) {
			return post(route('push'), request, signal);
		},
		pull(request, signal) {
			return post(route('pull'), request, signal);
		},
		snapshotChunk(request, signal) {
			return post(route('snapshot-chunk'), request, signal);
		},
	} satisfies ReplicaSyncPort;
}

function openRequestBody({
	protocolMajor,
	schemaIdentity,
}: ReplicaDatabaseBindingRequest): RecordAuthorityBindingRequest {
	return { protocolMajor, schemaIdentity };
}
