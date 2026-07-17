import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openRowAuthority, type RowAuthority } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { rowDocumentCodec } from './codec.js';
import { runRecordsCompaction } from './compaction.js';
import type { Records, RecordsPartition } from './contracts.js';

type OpenAuthority = {
	database: Database;
	authority: RowAuthority;
};

function partitionKey({ principalId, workspaceId }: RecordsPartition): string {
	return JSON.stringify([principalId, workspaceId]);
}

function databaseFilename(partition: RecordsPartition): string {
	return `${createHash('sha256').update(partitionKey(partition)).digest('hex')}.sqlite`;
}

/** Open the persistent Bun record authorities rooted in one deployment directory. */
export function createBunRecords({ dir }: { dir: string }) {
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
			database.run('PRAGMA journal_mode = WAL');
			const authority = openRowAuthority({
				database: createBunSqliteAdapter(database),
				codec: rowDocumentCodec,
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
		async enroll(partition, request, options) {
			return load(partition).authority.enroll(request, options);
		},
		async sync(partition, request, options) {
			const opened = load(partition);
			const response = opened.authority.sync(request, options);
			if (response.result === 'page' && request.sealedRound) {
				runRecordsCompaction(opened.authority);
			}
			return response;
		},
		async baselineScan(partition, request) {
			return load(partition).authority.baselineScan(request);
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
