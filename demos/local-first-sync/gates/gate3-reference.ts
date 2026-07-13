import {
	areRowsCanonical,
	type CandidateChunk,
	canonicalRows,
	exceedsCandidateLimits,
	type Gate3Authority,
	type Gate3Dump,
	isValidCandidateChunk,
	isValidCandidateManifest,
} from './gate3-protocol.js';
import type { Cells, Operation, SnapshotRow } from './protocol.js';

type DatabaseState = Gate3Dump['databases'][number];
type StagedUpload = NonNullable<Gate3Dump['stagedUpload']>;

/** Pure state-machine reference for the collapsed one-slot succession model. */
export function createGate3Reference(initial: {
	databaseId: string;
	schemaHash: string;
	rows: SnapshotRow[];
}) {
	let currentDatabaseId = initial.databaseId;
	let stagedUpload: StagedUpload | null = null;
	const databases = new Map<string, DatabaseState>([
		[
			initial.databaseId,
			{
				id: initial.databaseId,
				schemaHash: initial.schemaHash,
				status: 'live',
				head: 0,
				rows: canonicalRows(initial.rows),
			},
		],
	]);
	const checkpoints = new Map<string, CandidateChunk[]>();

	function sourceSnapshot() {
		const current = databases.get(currentDatabaseId);
		if (!current) throw new Error('current database is missing');
		return {
			databaseId: current.id,
			schemaHash: current.schemaHash,
			head: current.head,
			rows: canonicalRows(current.rows),
		};
	}

	const authority: Gate3Authority = {
		sourceSnapshot,
		stage(manifest) {
			if (!isValidCandidateManifest(manifest))
				return { ok: false, reason: 'invalid-manifest' };
			if (exceedsCandidateLimits(manifest))
				return { ok: false, reason: 'candidate-too-large' };
			if (databases.has(manifest.candidateId))
				return { ok: false, reason: 'candidate-already-exists' };
			if (manifest.sourceDatabaseId !== currentDatabaseId)
				return { ok: false, reason: 'wrong-source' };
			if (stagedUpload?.manifest.candidateId === manifest.candidateId)
				return {
					ok: true,
					candidateId: manifest.candidateId,
					replaced: false,
				};
			const replaced = stagedUpload !== null;
			stagedUpload = {
				manifest: structuredClone(manifest),
				sealed: false,
				chunks: [],
			};
			return { ok: true, candidateId: manifest.candidateId, replaced };
		},
		upload(candidateId, chunk) {
			if (stagedUpload?.manifest.candidateId !== candidateId)
				return { ok: false, reason: 'candidate-not-staged' };
			const expected = stagedUpload.manifest.chunks[chunk.index];
			if (!expected) return { ok: false, reason: 'chunk-out-of-range' };
			if (!isValidCandidateChunk(expected, chunk))
				return { ok: false, reason: 'invalid-chunk' };
			const existing = stagedUpload.chunks.find(
				(stored) => stored.index === chunk.index,
			);
			if (!existing) stagedUpload.chunks.push(structuredClone(chunk));
			return { ok: true };
		},
		seal(candidateId) {
			if (stagedUpload?.manifest.candidateId !== candidateId)
				return { ok: false, reason: 'candidate-not-staged' };
			if (stagedUpload.sealed) return { ok: true };
			if (stagedUpload.chunks.length !== stagedUpload.manifest.chunks.length)
				return { ok: false, reason: 'missing-chunks' };
			const rows = stagedUpload.chunks
				.toSorted((left, right) => left.index - right.index)
				.flatMap((chunk) => structuredClone(chunk.rows));
			if (!areRowsCanonical(rows))
				return { ok: false, reason: 'rows-not-canonical' };
			stagedUpload.sealed = true;
			return { ok: true };
		},
		activate(candidateId) {
			if (currentDatabaseId === candidateId)
				return { ok: true, status: 'already-active' };
			if (stagedUpload?.manifest.candidateId !== candidateId)
				return { ok: false, reason: 'candidate-not-staged' };
			if (!stagedUpload.sealed)
				return { ok: false, reason: 'candidate-not-sealed' };
			const { manifest } = stagedUpload;
			const source = databases.get(manifest.sourceDatabaseId);
			if (
				currentDatabaseId !== manifest.sourceDatabaseId ||
				!source ||
				source.head !== manifest.sourceHead
			)
				return { ok: false, reason: 'stale-head' };
			const chunks = stagedUpload.chunks
				.toSorted((left, right) => left.index - right.index)
				.map((chunk) => structuredClone(chunk));
			source.status = 'fenced';
			databases.set(candidateId, {
				id: candidateId,
				schemaHash: manifest.targetSchemaHash,
				status: 'live',
				head: 1,
				rows: chunks.flatMap((chunk) => structuredClone(chunk.rows)),
			});
			checkpoints.set(candidateId, chunks);
			currentDatabaseId = candidateId;
			stagedUpload = null;
			return { ok: true, status: 'activated' };
		},
		discard(candidateId) {
			if (stagedUpload?.manifest.candidateId !== candidateId)
				return { ok: false, reason: 'candidate-not-staged' };
			stagedUpload = null;
			return { ok: true };
		},
		write(databaseId, operation) {
			const database = databases.get(databaseId);
			if (database?.status === 'fenced')
				return { ok: false, reason: 'database-fenced' };
			if (!database || databaseId !== currentDatabaseId)
				return { ok: false, reason: 'database-not-live' };
			const rows = structuredClone(database.rows);
			if (!apply(rows, operation))
				return { ok: false, reason: 'create-conflict' };
			database.rows = canonicalRows(rows);
			database.head += 1;
			return { ok: true, head: database.head };
		},
		readDatabase(databaseId) {
			const database = databases.get(databaseId);
			if (!database) return { ok: false, reason: 'database-not-readable' };
			return {
				ok: true,
				snapshot: {
					databaseId,
					schemaHash: database.schemaHash,
					head: database.head,
					rows: canonicalRows(database.rows),
				},
			};
		},
		checkpointChunks(databaseId) {
			const chunks = checkpoints.get(databaseId);
			return chunks ? structuredClone(chunks) : null;
		},
		dump() {
			return {
				currentDatabaseId,
				stagedUpload: structuredClone(stagedUpload),
				databases: [...databases.values()]
					.map((database) => ({
						...structuredClone(database),
						rows: canonicalRows(database.rows),
					}))
					.sort((left, right) => left.id.localeCompare(right.id)),
				checkpoints: [...checkpoints]
					.map(([databaseId, chunks]) => ({
						databaseId,
						chunks: structuredClone(chunks),
					}))
					.sort((left, right) =>
						left.databaseId.localeCompare(right.databaseId),
					),
			};
		},
	};
	return authority;
}

function apply(rows: SnapshotRow[], operation: Operation): boolean {
	const index = rows.findIndex(
		(row) => row.table === operation.table && row.rowId === operation.rowId,
	);
	if (operation.kind === 'deleteRow') {
		if (index >= 0) rows.splice(index, 1);
		return true;
	}
	if (operation.kind === 'createRow') {
		if (index >= 0) return false;
		const cells: Cells = {};
		for (const [field, value] of Object.entries(operation.cells))
			if (value !== null) cells[field] = value;
		rows.push({ table: operation.table, rowId: operation.rowId, cells });
		return true;
	}
	const row = rows[index];
	if (!row) return true;
	for (const [field, value] of Object.entries(operation.cells)) {
		if (value === null) delete row.cells[field];
		else row.cells[field] = value;
	}
	return true;
}
