import { DurableObject } from 'cloudflare:workers';
import {
	openRecordAuthority,
	type RecordAuthority,
	type SnapshotChunkRequest,
	type SnapshotChunkResponse,
	type SyncRequest,
	type SyncResponse,
} from '@epicenter/record-sync';
import { createDurableObjectSqliteAdapter } from '@epicenter/record-sync/durable-object';
import * as Y from 'yjs';
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
	private readonly authority: RecordAuthority;
	private compaction: Promise<void> | undefined;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.authority = openRecordAuthority({
			database: createDurableObjectSqliteAdapter(ctx.storage),
			sha256,
			mergeBodyUpdates: (updates) =>
				Y.mergeUpdates(updates.map((update) => new Uint8Array(update))),
		});
	}

	async sync(request: SyncRequest): Promise<SyncResponse> {
		const response = this.authority.sync(request);
		if (response.ok && request.sealedRound) {
			const compaction = (this.compaction ?? Promise.resolve())
				.catch(() => {})
				.then(() =>
					this.authority.maybePublishSnapshot(RECORDS_COMPACTION_POLICY),
				)
				.then(() => {})
				.catch(() => {});
			this.compaction = compaction;
			try {
				await compaction;
			} finally {
				if (this.compaction === compaction) this.compaction = undefined;
			}
		}
		return response;
	}

	async snapshotChunk(
		request: SnapshotChunkRequest,
	): Promise<SnapshotChunkResponse> {
		return this.authority.snapshotChunk(request);
	}
}

type RecordsRpc = {
	sync(request: SyncRequest): Promise<SyncResponse>;
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
		sync: (partition, request) => get(partition).sync(request),
		snapshotChunk: (partition, request) =>
			get(partition).snapshotChunk(request),
	};
}
