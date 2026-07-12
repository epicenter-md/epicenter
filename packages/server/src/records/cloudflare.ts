import { DurableObject } from 'cloudflare:workers';
import {
	openRecordAuthority,
	type PullRequest,
	type PullResponse,
	type PushRequest,
	type PushResponse,
	type RecordAuthority,
	type RecordAuthorityBindingRequest,
	type RecordAuthorityBindingResult,
	restoreRecordAuthority,
	type SnapshotChunkRequest,
	type SnapshotChunkResponse,
} from '@epicenter/record-sync';
import { createDurableObjectSqliteAdapter } from '@epicenter/record-sync/durable-object';
import { RECORDS_COMPACTION_POLICY } from './compaction.js';
import type { Records, RecordsPartition } from './contracts.js';

function partitionName({ principalId, workspaceId }: RecordsPartition): string {
	return JSON.stringify([principalId, workspaceId]);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

/** One server-owned logical-record authority backed by Durable Object SQLite. */
export class RecordAuthorityDurableObject extends DurableObject {
	private authority: RecordAuthority | null;
	private compaction: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.authority =
			restoreRecordAuthority({
				database: createDurableObjectSqliteAdapter(ctx.storage),
				sha256,
			})?.authority ?? null;
	}

	async open(
		request: RecordAuthorityBindingRequest,
	): Promise<RecordAuthorityBindingResult> {
		const opened = openRecordAuthority({
			database: createDurableObjectSqliteAdapter(this.ctx.storage),
			request,
			createDatabaseIncarnationId: () => crypto.randomUUID(),
			sha256,
		});
		if (!opened.ok) return opened;
		this.authority = opened.authority;
		return {
			ok: true,
			databaseIncarnationId: opened.databaseIncarnationId,
		};
	}

	async push(request: PushRequest): Promise<PushResponse> {
		const authority = this.requireAuthority();
		const response = authority.push(request);
		if (response.ok) {
			const compaction = (this.compaction ?? Promise.resolve())
				.catch(() => {})
				.then(() => authority.maybePublishSnapshot(RECORDS_COMPACTION_POLICY))
				.then(() => {});
			this.compaction = compaction;
			try {
				await compaction;
			} finally {
				if (this.compaction === compaction) this.compaction = undefined;
			}
		}
		return response;
	}

	async pull(request: PullRequest): Promise<PullResponse> {
		return this.requireAuthority().pull(request);
	}

	async snapshotChunk(
		request: SnapshotChunkRequest,
	): Promise<SnapshotChunkResponse> {
		return this.requireAuthority().snapshotChunk(request);
	}

	private requireAuthority(): RecordAuthority {
		if (!this.authority)
			throw new Error(
				'Records workspace must be opened before synchronization',
			);
		return this.authority;
	}
}

type RecordsRpc = {
	open(
		request: RecordAuthorityBindingRequest,
	): Promise<RecordAuthorityBindingResult>;
	push(request: PushRequest): Promise<PushResponse>;
	pull(request: PullRequest): Promise<PullResponse>;
	snapshotChunk(request: SnapshotChunkRequest): Promise<SnapshotChunkResponse>;
};

/** Build the portable records backend over the hosted Worker's DO namespace. */
export function createDurableObjectRecords(
	namespace: DurableObjectNamespace<RecordAuthorityDurableObject>,
): Records {
	function get(partition: RecordsPartition): RecordsRpc {
		// Cloudflare's recursive RPC proxy type exceeds TypeScript's instantiation
		// limit for the nested snapshot response. Keep that compiler limitation at
		// this runtime-owned stub boundary while checking the class methods above.
		return namespace.getByName(
			partitionName(partition),
		) as unknown as RecordsRpc;
	}

	return {
		open: (partition, request) => get(partition).open(request),
		push: (partition, request) => get(partition).push(request),
		pull: (partition, request) => get(partition).pull(request),
		snapshotChunk: (partition, request) =>
			get(partition).snapshotChunk(request),
	};
}
