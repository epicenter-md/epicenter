import { DurableObject } from 'cloudflare:workers';
import {
	type BaselineScanRequest,
	type BaselineScanResponse,
	type EnrollRequest,
	type EnrollResponse,
	openRowAuthority,
	type RowAuthority,
	type SyncRequest,
	type SyncResponse,
} from '@epicenter/row-sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/row-sync/durable-object';
import { rowDocumentCodec } from './codec.js';
import { runRecordsCompaction } from './compaction.js';
import type { Records, RecordsPartition } from './contracts.js';

function partitionName({ principalId, workspaceId }: RecordsPartition): string {
	return JSON.stringify([principalId, workspaceId]);
}

/** One server-owned logical-record authority backed by Durable Object SQLite. */
export class RowAuthorityDurableObject extends DurableObject {
	private readonly authority: RowAuthority;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.authority = openRowAuthority({
			database: createDurableObjectSqliteAdapter(
				ctx.storage as unknown as DurableObjectSqliteStorage,
			),
			codec: rowDocumentCodec,
		});
	}

	async enroll(request: EnrollRequest): Promise<EnrollResponse> {
		return this.authority.enroll(request);
	}

	async sync(request: SyncRequest): Promise<SyncResponse> {
		const response = this.authority.sync(request);
		if (response.ok && request.sealedRound) {
			runRecordsCompaction(this.authority);
		}
		return response;
	}

	async baselineScan(
		request: BaselineScanRequest,
	): Promise<BaselineScanResponse> {
		return this.authority.baselineScan(request);
	}
}

type RecordsRpc = {
	enroll(request: EnrollRequest): Promise<EnrollResponse>;
	sync(request: SyncRequest): Promise<SyncResponse>;
	baselineScan(request: BaselineScanRequest): Promise<BaselineScanResponse>;
};

/** Build the portable records backend over the hosted Worker's DO namespace. */
export function createDurableObjectRecords(
	namespace: DurableObjectNamespace<RowAuthorityDurableObject>,
): Records {
	function get(partition: RecordsPartition): RecordsRpc {
		// Cloudflare's recursive RPC proxy type exceeds TypeScript's instantiation
		// limit for the nested row-sync responses. Keep that compiler limitation at
		// this runtime-owned stub boundary while checking the class methods above.
		return namespace.getByName(
			partitionName(partition),
		) as unknown as RecordsRpc;
	}

	return {
		enroll: (partition, request) => get(partition).enroll(request),
		sync: (partition, request) => get(partition).sync(request),
		baselineScan: (partition, request) => get(partition).baselineScan(request),
	};
}
