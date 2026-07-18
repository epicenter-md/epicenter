import { DurableObject } from 'cloudflare:workers';
import type {
	AcquireRequest,
	AcquireResponse,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
} from '@epicenter/row-sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { DOCUMENT_SUBPROTOCOL } from '@epicenter/sync/document-v3';
import {
	CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS,
	CloudflareWorkspaceDocumentRuntime,
} from '../document-hub/cloudflare.js';
import type { WorkspaceDocuments } from '../document-hub/contracts.js';
import {
	type AccountRowAuthority,
	openAccountRowAuthority,
} from '../workspace-authority/authority.js';
import { runCurrentStateTransportCompaction } from './current-state-compaction.js';
import type {
	CurrentStateRecords,
	CurrentStateRecordsPartition,
} from './current-state-contracts.js';

function principalName(
	principalId: CurrentStateRecordsPartition['principalId'],
): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

function partitionName({ principalId }: CurrentStateRecordsPartition): string {
	return principalName(principalId);
}

/** One server-owned current-state account authority in Durable Object SQLite. */
export class CurrentStateRowAuthorityDurableObject extends DurableObject {
	private readonly authority: AccountRowAuthority;
	private readonly documents: CloudflareWorkspaceDocumentRuntime;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.authority = openAccountRowAuthority({
			database: createDurableObjectSqliteAdapter(
				ctx.storage as unknown as DurableObjectSqliteStorage,
			),
			readDatabaseSize: () =>
				(ctx.storage as unknown as { sql: { databaseSize: number } }).sql
					.databaseSize,
		});
		this.documents = new CloudflareWorkspaceDocumentRuntime(
			ctx,
			(workspaceId) => this.authority.workspace(workspaceId).documents,
		);
	}

	override fetch(request: Request): Promise<Response> {
		return this.documents.fetch(request);
	}

	override webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): void {
		this.documents.webSocketMessage(socket, message);
	}

	override webSocketClose(socket: WebSocket): void {
		this.documents.webSocketClose(socket);
	}

	override webSocketError(socket: WebSocket): void {
		this.documents.webSocketError(socket);
	}

	override alarm(): Promise<void> {
		return this.documents.alarm();
	}

	async deleteWorkspace(workspaceId: string): Promise<void> {
		this.authority.deleteWorkspace(workspaceId);
		this.documents.evictWorkspace(workspaceId);
	}

	async hasReplica(workspaceId: string, replicaId: string): Promise<boolean> {
		return this.authority.workspace(workspaceId).hasReplica(replicaId);
	}

	async push(workspaceId: string, request: PushRequest): Promise<PushResponse> {
		const workspace = this.authority.workspace(workspaceId);
		const response = workspace.push(request);
		if (response.result === 'accepted') {
			this.documents.evictTombstoned(
				workspaceId,
				request.intents
					.filter((intent) => intent.kind === 'delete')
					.map(({ table, rowId }) => ({ table, rowId })),
			);
		}
		if (response.result === 'accepted') {
			runCurrentStateTransportCompaction(
				workspace.compactThrough,
				response.receipt,
			);
		}
		return response;
	}

	async pull(workspaceId: string, request: PullRequest): Promise<PullResponse> {
		return this.authority.workspace(workspaceId).pull(request);
	}

	async acquire(
		workspaceId: string,
		request: AcquireRequest,
	): Promise<AcquireResponse> {
		return this.authority.workspace(workspaceId).acquire(request);
	}

	/** Read this authority's absolute physical SQLite size. */
	async databaseSize(): Promise<number> {
		return (this.ctx.storage as unknown as { sql: { databaseSize: number } })
			.sql.databaseSize;
	}
}

/** Route authorized document upgrades into the principal's account authority. */
export function createCurrentStateDurableObjectDocuments(
	namespace: DurableObjectNamespace<CurrentStateRowAuthorityDurableObject>,
): WorkspaceDocuments {
	return {
		handleUpgrade({ partition, address, authorizationExpiresAt, request }) {
			const headers = new Headers(request.headers);
			headers.set('sec-websocket-protocol', DOCUMENT_SUBPROTOCOL);
			headers.set(
				CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.workspace,
				partition.workspaceId,
			);
			headers.set(CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.table, address.table);
			headers.set(CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.row, address.rowId);
			headers.set(
				CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.authorizationExpiresAt,
				String(authorizationExpiresAt),
			);
			return namespace.getByName(partitionName(partition)).fetch(
				new Request('https://workspace-authority.internal/document', {
					method: 'GET',
					headers,
				}),
			);
		},
		rejectUpgrade({ code, reason }) {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			server.accept();
			server.close(code, reason);
			return new Response(null, {
				status: 101,
				webSocket: client,
				headers: { 'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL },
			});
		},
	};
}

type CurrentStateRecordsRpc = {
	deleteWorkspace(workspaceId: string): Promise<void>;
	hasReplica(workspaceId: string, replicaId: string): Promise<boolean>;
	push(workspaceId: string, request: PushRequest): Promise<PushResponse>;
	pull(workspaceId: string, request: PullRequest): Promise<PullResponse>;
	acquire(
		workspaceId: string,
		request: AcquireRequest,
	): Promise<AcquireResponse>;
};

/** Build current-state records over an account Durable Object namespace. */
export function createCurrentStateDurableObjectRecords(
	namespace: DurableObjectNamespace<CurrentStateRowAuthorityDurableObject>,
): CurrentStateRecords {
	function get(
		partition: CurrentStateRecordsPartition,
	): CurrentStateRecordsRpc {
		return namespace.getByName(
			partitionName(partition),
		) as unknown as CurrentStateRecordsRpc;
	}

	return {
		deleteWorkspace: (partition) =>
			get(partition).deleteWorkspace(partition.workspaceId),
		hasReplica: (partition, replicaId) =>
			get(partition).hasReplica(partition.workspaceId, replicaId),
		push: (partition, request) =>
			get(partition).push(partition.workspaceId, request),
		pull: (partition, request) =>
			get(partition).pull(partition.workspaceId, request),
		acquire: (partition, request) =>
			get(partition).acquire(partition.workspaceId, request),
	};
}

/** Read one current-state account authority's absolute physical size. */
export function readCurrentStateAccountDatabaseSize(
	namespace: DurableObjectNamespace<CurrentStateRowAuthorityDurableObject>,
	principalId: CurrentStateRecordsPartition['principalId'],
): Promise<number> {
	return (
		namespace.getByName(principalName(principalId)) as unknown as {
			databaseSize(): Promise<number>;
		}
	).databaseSize();
}
