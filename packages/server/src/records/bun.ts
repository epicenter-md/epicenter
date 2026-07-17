import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	openRecordAuthority,
	type RecordAuthority,
	type Sha256,
} from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import * as Y from 'yjs';
import { RECORDS_COMPACTION_POLICY } from './compaction.js';
import type { Records, RecordsPartition } from './contracts.js';

type OpenAuthority = {
	database: Database;
	authority: RecordAuthority;
	compaction?: Promise<void>;
};

function partitionKey({ principalId, workspaceId }: RecordsPartition): string {
	return JSON.stringify([principalId, workspaceId]);
}

function databaseFilename(partition: RecordsPartition): string {
	return `${createHash('sha256').update(partitionKey(partition)).digest('hex')}.sqlite`;
}

/** Open the persistent Bun record authorities rooted in one deployment directory. */
export function createBunRecords({
	dir,
	sha256,
}: {
	dir: string;
	sha256: Sha256;
}) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<string, OpenAuthority>();
	let isClosed = false;

	function load(partition: RecordsPartition): OpenAuthority {
		if (isClosed) throw new Error('Bun records backend is closed');
		const key = partitionKey(partition);
		const cached = authorities.get(key);
		if (cached) return cached;

		const database = new Database(join(dir, databaseFilename(partition)), {
			create: true,
			strict: true,
		});
		try {
			const authority = openRecordAuthority({
				database: createBunSqliteAdapter(database),
				sha256,
				mergeBodyUpdates: (updates) =>
					Y.mergeUpdates(updates.map((update) => new Uint8Array(update))),
			});
			const opened = {
				database,
				authority,
			};
			authorities.set(key, opened);
			return opened;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	const records: Records = {
		async sync(partition, request) {
			const opened = load(partition);
			const response = opened.authority.sync(request);
			if (response.ok && request.sealedRound) {
				const compaction = (opened.compaction ?? Promise.resolve())
					.catch(() => {})
					.then(() =>
						opened.authority.maybePublishSnapshot(RECORDS_COMPACTION_POLICY),
					)
					.then(() => {})
					.catch(() => {});
				opened.compaction = compaction;
				try {
					await compaction;
				} finally {
					if (opened.compaction === compaction) opened.compaction = undefined;
				}
			}
			return response;
		},
		async snapshotChunk(partition, request) {
			return load(partition).authority.snapshotChunk(request);
		},
	};

	return {
		records,
		close(): void {
			if (isClosed) return;
			isClosed = true;
			for (const { database } of authorities.values()) database.close();
			authorities.clear();
		},
	};
}

export type BunRecords = ReturnType<typeof createBunRecords>;
