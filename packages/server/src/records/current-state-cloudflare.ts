import { DurableObject } from 'cloudflare:workers';
import type { PrincipalId } from '@epicenter/identity';
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
import { openAccountRowAuthority } from '../workspace-authority/authority.js';
import { runCurrentStateTransportCompaction } from './current-state-compaction.js';
import type {
	AccountAuthorities,
	AccountAuthority,
} from './current-state-contracts.js';

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

/** One server-owned current-state account authority in Durable Object SQLite. */
export class CurrentStateRowAuthorityDurableObject extends DurableObject {
	private readonly authority: ReturnType<typeof openAccountRowAuthority>;
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

	/**
	 * Delete the whole account: every socket, alarm, and storage byte.
	 *
	 * Idempotent. This live instance's in-memory authority is broken after
	 * `deleteAll` (its schema is gone), so later scalar or document operations
	 * on it fail until the actor is evicted; the durable gate against them is
	 * the deployment removing the principal's credentials.
	 */
	async deleteAccount(): Promise<void> {
		this.documents.evictAll();
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
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

type AccountAuthorityRpc = {
	deleteWorkspace(workspaceId: string): Promise<void>;
	deleteAccount(): Promise<void>;
	hasReplica(workspaceId: string, replicaId: string): Promise<boolean>;
	push(workspaceId: string, request: PushRequest): Promise<PushResponse>;
	pull(workspaceId: string, request: PullRequest): Promise<PullResponse>;
	acquire(
		workspaceId: string,
		request: AcquireRequest,
	): Promise<AcquireResponse>;
	databaseSize(): Promise<number>;
};

/** Locate account authorities over one Durable Object namespace. */
export function createDurableObjectAccountAuthorities(
	namespace: DurableObjectNamespace<CurrentStateRowAuthorityDurableObject>,
): AccountAuthorities {
	return {
		authority(principalId): AccountAuthority {
			const stub = () =>
				namespace.getByName(
					principalName(principalId),
				) as unknown as AccountAuthorityRpc;
			return {
				hasReplica: (workspaceId, replicaId) =>
					stub().hasReplica(workspaceId, replicaId),
				push: (workspaceId, request) => stub().push(workspaceId, request),
				pull: (workspaceId, request) => stub().pull(workspaceId, request),
				acquire: (workspaceId, request) => stub().acquire(workspaceId, request),
				deleteWorkspace: (workspaceId) => stub().deleteWorkspace(workspaceId),
				deleteAccount: () => stub().deleteAccount(),
				databaseSize: () => stub().databaseSize(),
				acceptDocumentUpgrade({
					workspaceId,
					address,
					authorizationExpiresAt,
					request,
				}) {
					const headers = new Headers(request.headers);
					headers.set('sec-websocket-protocol', DOCUMENT_SUBPROTOCOL);
					headers.set(
						CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.workspace,
						workspaceId,
					);
					headers.set(
						CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.table,
						address.table,
					);
					headers.set(CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.row, address.rowId);
					headers.set(
						CLOUDFLARE_DOCUMENT_INTERNAL_HEADERS.authorizationExpiresAt,
						String(authorizationExpiresAt),
					);
					return namespace.getByName(principalName(principalId)).fetch(
						new Request('https://workspace-authority.internal/document', {
							method: 'GET',
							headers,
						}),
					);
				},
			};
		},
		rejectDocumentUpgrade({ code, reason }) {
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
