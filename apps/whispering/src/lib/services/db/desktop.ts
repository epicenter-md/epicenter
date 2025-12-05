import { Err, Ok } from 'wellcrafted/result';
import type { DownloadService } from '$lib/services/download';
import { createFileSystemDb } from './file-system';
import type { DbService } from './types';
import { DbServiceErr } from './types';
import { createDbServiceWeb } from './web';

/**
 * Desktop DB Service with dual read/single write pattern.
 *
 * Phase 2 Migration Strategy:
 * - READS: Merge data from BOTH IndexedDB and file system (file system takes precedence)
 * - WRITES: Only write to file system (new recordings)
 * - Old recordings remain in IndexedDB until naturally migrated
 * - When updating an old recording, it's automatically moved to file system
 *
 * This ensures:
 * - No data loss during migration
 * - Gradual, automatic migration as users interact with recordings
 * - File system becomes the source of truth over time
 */

export function createDbServiceDesktop({
	DownloadService,
}: {
	DownloadService: DownloadService;
}): DbService {
	const fileSystemDb = createFileSystemDb();
	const indexedDb = createDbServiceWeb({ DownloadService });

	return {
		recordings: {
			getAll: async () => {
				// DUAL READ: Merge from both sources (file system takes precedence)
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.recordings.getAll(),
					indexedDb.recordings.getAll(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting all recordings from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRecordings = fsResult.data ?? [];
				const idbRecordings = idbResult.data ?? [];

				// Merge, preferring file system (newer) over IndexedDB
				const merged = new Map();

				// Add IndexedDB recordings first
				for (const rec of idbRecordings) {
					merged.set(rec.id, rec);
				}

				// Overwrite with file system recordings (takes precedence)
				for (const rec of fsRecordings) {
					merged.set(rec.id, rec);
				}

				// Convert back to array and sort by timestamp (newest first)
				const result = Array.from(merged.values());
				result.sort(
					(a, b) =>
						new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
				);

				return Ok(result);
			},

			getLatest: async () => {
				// DUAL READ: Check both sources via getAll
				const { data: recordings, error } = await createDbServiceDesktop({
					DownloadService,
				}).recordings.getAll();

				if (error) return Err(error);

				if (recordings.length === 0) return Ok(null);
				return Ok(recordings[0]); // Already sorted by timestamp desc
			},

			getTranscribingIds: async () => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.recordings.getTranscribingIds(),
					indexedDb.recordings.getTranscribingIds(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message:
							'Error getting transcribing recording ids from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Use data from successful sources (empty array for failed ones)
				const fsIds = fsResult.data ?? [];
				const idbIds = idbResult.data ?? [];

				// Combine and deduplicate
				const combined = new Set([...fsIds, ...idbIds]);
				return Ok(Array.from(combined));
			},

			getById: async (id: string) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult = await fileSystemDb.recordings.getById(id);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.recordings.getById(id);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error only if both actually errored
				// (not just returned null/undefined)
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting recording by id from both sources',
						context: {
							id,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Not found in either source (but no errors)
				return Ok(null);
			},

			create: async (params) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.recordings.create(params);
			},

			update: async (recording) => {
				// SINGLE WRITE: Only to file system
				// This automatically migrates recordings from IndexedDB to file system
				return fileSystemDb.recordings.update(recording);
			},

			delete: async (recordings) => {
				// Delete from BOTH sources to ensure complete removal
				const recordingsArray = Array.isArray(recordings)
					? recordings
					: [recordings];

				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.recordings.delete(recordingsArray),
					indexedDb.recordings.delete(recordingsArray),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error deleting recordings from both sources',
						context: {
							recordings,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			cleanupExpired: async (params) => {
				// Clean up from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.recordings.cleanupExpired(params),
					indexedDb.recordings.cleanupExpired(params),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error cleaning up expired recordings from both sources',
						context: {
							...params,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			getAudioBlob: async (recordingId) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult =
					await fileSystemDb.recordings.getAudioBlob(recordingId);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.recordings.getAudioBlob(recordingId);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting audio blob from both sources',
						context: {
							recordingId,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Not found in either source (but no errors)
				throw new Error(`Audio not found for recording ${recordingId}`);
			},

			ensureAudioPlaybackUrl: async (recordingId) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult =
					await fileSystemDb.recordings.ensureAudioPlaybackUrl(recordingId);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult =
					await indexedDb.recordings.ensureAudioPlaybackUrl(recordingId);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting audio playback URL from both sources',
						context: {
							recordingId,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Not found in either source (but no errors)
				throw new Error(`Audio not found for recording ${recordingId}`);
			},

			revokeAudioUrl: (recordingId) => {
				// Revoke from BOTH sources
				fileSystemDb.recordings.revokeAudioUrl(recordingId);
				indexedDb.recordings.revokeAudioUrl(recordingId);
			},

			clear: async () => {
				// Clear from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.recordings.clear(),
					indexedDb.recordings.clear(),
				]);

				// Return error only if both failed
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error clearing recordings from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				return Ok(undefined);
			},

			getCount: async () => {
				// Get count from file system (source of truth)
				return fileSystemDb.recordings.getCount();
			},
		},

		transformations: {
			getAll: async () => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.getAll(),
					indexedDb.transformations.getAll(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting all transformations from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Use data from successful sources (empty array for failed ones)
				const fsTransformations = fsResult.data ?? [];
				const idbTransformations = idbResult.data ?? [];

				// Merge, preferring file system (newer) over IndexedDB
				const merged = new Map();

				for (const t of idbTransformations) {
					merged.set(t.id, t);
				}

				for (const t of fsTransformations) {
					merged.set(t.id, t);
				}

				return Ok(Array.from(merged.values()));
			},

			getById: async (id: string) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult = await fileSystemDb.transformations.getById(id);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.transformations.getById(id);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error only if both actually errored
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting transformation by id from both sources',
						context: {
							id,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Not found in either source (but no errors)
				return Ok(null);
			},

			create: async (transformation) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.transformations.create(transformation);
			},

			update: async (transformation) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.transformations.update(transformation);
			},

			delete: async (transformations) => {
				// Delete from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.delete(transformations),
					indexedDb.transformations.delete(transformations),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error deleting transformations from both sources',
						context: {
							transformations,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			clear: async () => {
				// Clear from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.transformations.clear(),
					indexedDb.transformations.clear(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error clearing transformations from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			getCount: async () => {
				// Get count from file system (source of truth)
				return fileSystemDb.transformations.getCount();
			},
		},

		runs: {
			getAll: async () => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getAll(),
					indexedDb.runs.getAll(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting all transformation runs from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRuns = fsResult.data ?? [];
				const idbRuns = idbResult.data ?? [];

				// Merge, preferring file system
				const merged = new Map();
				for (const run of fsRuns) {
					merged.set(run.id, run);
				}
				for (const run of idbRuns) {
					if (!merged.has(run.id)) {
						merged.set(run.id, run);
					}
				}

				return Ok(Array.from(merged.values()));
			},

			getById: async (id: string) => {
				// DUAL READ: Check file system first, fallback to IndexedDB
				const fsResult = await fileSystemDb.runs.getById(id);

				// If found in file system, return it
				if (fsResult.data) {
					return Ok(fsResult.data);
				}

				// Not in file system, check IndexedDB
				const idbResult = await indexedDb.runs.getById(id);

				// If found in IndexedDB, return it
				if (idbResult.data) {
					return Ok(idbResult.data);
				}

				// If both failed, return an error only if both actually errored
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message: 'Error getting transformation run by id from both sources',
						context: {
							id,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Not found in either source (but no errors)
				return Ok(null);
			},

			getByTransformationId: async (transformationId: string) => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getByTransformationId(transformationId),
					indexedDb.runs.getByTransformationId(transformationId),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message:
							'Error getting transformation runs by transformation id from both sources',
						context: {
							transformationId,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRuns = fsResult.data ?? [];
				const idbRuns = idbResult.data ?? [];

				// Merge, preferring file system
				const merged = new Map();

				for (const run of idbRuns) {
					merged.set(run.id, run);
				}

				for (const run of fsRuns) {
					merged.set(run.id, run);
				}

				// Convert back to array and sort by startedAt (newest first)
				const result = Array.from(merged.values());
				result.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);

				return Ok(result);
			},

			getByRecordingId: async (recordingId: string) => {
				// DUAL READ: Merge from both sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.getByRecordingId(recordingId),
					indexedDb.runs.getByRecordingId(recordingId),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return Err({
						name: 'DbServiceError' as const,
						message:
							'Error getting transformation runs by recording id from both sources',
						context: {
							recordingId,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Use data from successful sources (empty array for failed ones)
				const fsRuns = fsResult.data ?? [];
				const idbRuns = idbResult.data ?? [];

				// Merge, preferring file system
				const merged = new Map();

				for (const run of idbRuns) {
					merged.set(run.id, run);
				}

				for (const run of fsRuns) {
					merged.set(run.id, run);
				}

				// Convert back to array and sort by startedAt (newest first)
				const result = Array.from(merged.values());
				result.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);

				return Ok(result);
			},

			create: async (params) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.create(params);
			},

			addStep: async (run, step) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.addStep(run, step);
			},

			failStep: async (run, stepRunId, error) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.failStep(run, stepRunId, error);
			},

			completeStep: async (run, stepRunId, output) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.completeStep(run, stepRunId, output);
			},

			complete: async (run, output) => {
				// SINGLE WRITE: Only to file system
				return fileSystemDb.runs.complete(run, output);
			},

			delete: async (runs) => {
				// Delete from BOTH sources to ensure complete removal
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.delete(runs),
					indexedDb.runs.delete(runs),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbServiceErr({
						message: 'Error deleting transformation runs from both sources',
						context: {
							runs,
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			clear: async () => {
				// Clear from BOTH sources
				const [fsResult, idbResult] = await Promise.all([
					fileSystemDb.runs.clear(),
					indexedDb.runs.clear(),
				]);

				// If both failed, return an error
				if (fsResult.error && idbResult.error) {
					return DbServiceErr({
						message: 'Error clearing transformation runs from both sources',
						context: {
							fileSystemError: fsResult.error,
							indexedDbError: idbResult.error,
						},
						cause: fsResult.error,
					});
				}

				// Success if at least one succeeded
				return Ok(undefined);
			},

			getCount: async () => {
				// Get count from file system (source of truth)
				return fileSystemDb.runs.getCount();
			},
		},
	};
}
