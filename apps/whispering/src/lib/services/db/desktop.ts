import { join } from '@tauri-apps/api/path';
import { exists, mkdir, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import matter from 'gray-matter';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { PATHS } from '$lib/constants/paths';
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

	// Run migrations SEQUENTIALLY (one at a time) to avoid resource contention
	// Each migration waits for the previous one to complete
	const recordingResultPromise = migrateRecordings({ indexedDb, fileSystemDb });

	const transformationResultPromise = (async () => {
		await recordingResultPromise;
		return await migrateTransformations({ indexedDb, fileSystemDb });
	})();

	const runsResultPromise = (async () => {
		await transformationResultPromise;
		return await migrateTransformationRuns({ indexedDb, fileSystemDb });
	})();

	return {
		recordings: {
			getAll: async () => {
				// Check if recordings migration completed successfully
				const { error: migrationError } = await recordingResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.recordings.getAll();
				}

				// If migration failed, fall back to DUAL READ: Merge from both sources
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
				// Check if recordings migration completed successfully
				const { error: migrationError } = await recordingResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.recordings.getLatest();
				}

				// If migration failed, fall back to DUAL READ: Check both sources via getAll
				const { data: recordings, error } = await createDbServiceDesktop({
					DownloadService,
				}).recordings.getAll();

				if (error) return Err(error);

				if (recordings.length === 0) return Ok(null);
				return Ok(recordings[0]); // Already sorted by timestamp desc
			},

			getTranscribingIds: async () => {
				// Check if recordings migration completed successfully
				const { error: migrationError } = await recordingResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.recordings.getTranscribingIds();
				}

				// If migration failed, fall back to DUAL READ: Merge from both sources
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
				// Check if recordings migration completed successfully
				const { error: migrationError } = await recordingResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.recordings.getById(id);
				}

				// If migration failed, fall back to DUAL READ: Check file system first, fallback to IndexedDB
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
				// Check if recordings migration completed successfully
				const { error: migrationError } = await recordingResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.recordings.getAudioBlob(recordingId);
				}

				// If migration failed, fall back to DUAL READ: Check file system first, fallback to IndexedDB
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
				// Check if recordings migration completed successfully
				const { error: migrationError } = await recordingResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.recordings.ensureAudioPlaybackUrl(recordingId);
				}

				// If migration failed, fall back to DUAL READ: Check file system first, fallback to IndexedDB
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
		},

		transformations: {
			getAll: async () => {
				// Check if transformations migration completed successfully
				const { error: migrationError } = await transformationResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.transformations.getAll();
				}

				// If migration failed, fall back to DUAL READ: Merge from both sources
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
				// Check if transformations migration completed successfully
				const { error: migrationError } = await transformationResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.transformations.getById(id);
				}

				// If migration failed, fall back to DUAL READ: Check file system first, fallback to IndexedDB
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
		},

		runs: {
			getById: async (id: string) => {
				// Check if runs migration completed successfully
				const { error: migrationError } = await runsResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.runs.getById(id);
				}

				// If migration failed, fall back to DUAL READ: Check file system first, fallback to IndexedDB
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
				// Check if runs migration completed successfully
				const { error: migrationError } = await runsResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.runs.getByTransformationId(transformationId);
				}

				// If migration failed, fall back to DUAL READ: Merge from both sources
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
				// Check if runs migration completed successfully
				const { error: migrationError} = await runsResultPromise;

				// If migration succeeded, only read from file system
				if (!migrationError) {
					return fileSystemDb.runs.getByRecordingId(recordingId);
				}

				// If migration failed, fall back to DUAL READ: Merge from both sources
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
		},
	};
}

/**
 * Migrate recordings from IndexedDB to file system.
 * Includes audio blobs downloaded to disk.
 * Deletes recordings from IndexedDB immediately after successful migration.
 */
async function migrateRecordings({
	indexedDb,
	fileSystemDb,
}: {
	indexedDb: DbService;
	fileSystemDb: DbService;
}) {
	return tryAsync({
		try: async () => {
			const { data: recordings, error: getRecordingsError } =
				await indexedDb.recordings.getAll();

			if (getRecordingsError || !recordings || recordings.length === 0) {
				if (getRecordingsError) {
					console.error(
						'Failed to get recordings from IndexedDB:',
						getRecordingsError,
					);
				}
				return;
			}

			console.log(`Starting migration of ${recordings.length} recordings`);

			for (const recording of recordings) {
				// Idempotent check: if already in file system, just delete from IndexedDB
				const { data: existing } = await fileSystemDb.recordings.getById(
					recording.id,
				);
				if (existing) {
					await indexedDb.recordings.delete([recording]);
					continue;
				}

				// Get audio blob
				const { data: audio, error: audioError } =
					await indexedDb.recordings.getAudioBlob(recording.id);

				if (audioError || !audio) {
					console.warn(
						`Skipping recording ${recording.id}: failed to get audio`,
						audioError,
					);
					continue;
				}

				// Create in file system
				const { error: createError } = await fileSystemDb.recordings.create({
					recording,
					audio,
				});

				if (createError) {
					console.warn(
						`Failed to migrate recording ${recording.id}`,
						createError,
					);
					continue;
				}

				// SUCCESS - Delete from IndexedDB immediately
				await indexedDb.recordings.delete([recording]);
			}

			console.log('Recordings migration complete');
		},
		catch: (error) =>
			DbServiceErr({
				message: 'Failed to migrate recordings from IndexedDB to file system',
				cause: error,
			}),
	});
}

/**
 * Migrate transformations from IndexedDB to file system.
 * Deletes transformations from IndexedDB immediately after successful migration.
 */
async function migrateTransformations({
	indexedDb,
	fileSystemDb,
}: {
	indexedDb: DbService;
	fileSystemDb: DbService;
}) {
	return tryAsync({
		try: async () => {
			const { data: transformations, error: getTransformationsError } =
				await indexedDb.transformations.getAll();

			if (
				getTransformationsError ||
				!transformations ||
				transformations.length === 0
			) {
				if (getTransformationsError) {
					console.error(
						'Failed to get transformations from IndexedDB:',
						getTransformationsError,
					);
				}
				return;
			}

			console.log(
				`Starting migration of ${transformations.length} transformations`,
			);

			for (const transformation of transformations) {
				// Idempotent check: if already in file system, just delete from IndexedDB
				const { data: existing } = await fileSystemDb.transformations.getById(
					transformation.id,
				);
				if (existing) {
					await indexedDb.transformations.delete([transformation]);
					continue;
				}

				// Create in file system
				const { error: createError } =
					await fileSystemDb.transformations.create(transformation);

				if (createError) {
					console.warn(
						`Failed to migrate transformation ${transformation.id}`,
						createError,
					);
					continue;
				}

				// SUCCESS - Delete from IndexedDB immediately
				await indexedDb.transformations.delete([transformation]);
			}

			console.log('Transformations migration complete');
		},
		catch: (error) =>
			DbServiceErr({
				message:
					'Failed to migrate transformations from IndexedDB to file system',
				cause: error,
			}),
	});
}

/**
 * Migrate transformation runs from IndexedDB to file system.
 * Preserves exact run data including IDs.
 *
 * Note: Does not delete runs from IndexedDB after migration because
 * the runs interface doesn't have a delete method. Runs are small metadata
 * so this is acceptable.
 */
async function migrateTransformationRuns({
	indexedDb,
	fileSystemDb,
}: {
	indexedDb: DbService;
	fileSystemDb: DbService;
}) {
	return tryAsync({
		try: async () => {
			// Get all transformations to iterate through their runs
			const { data: transformations, error: getTransformationsError } =
				await indexedDb.transformations.getAll();

			if (getTransformationsError || !transformations) {
				if (getTransformationsError) {
					console.error(
						'Failed to get transformations from IndexedDB:',
						getTransformationsError,
					);
				}
				return;
			}

			console.log(
				`Starting migration of transformation runs for ${transformations.length} transformations`,
			);

			for (const transformation of transformations) {
				const { data: runs, error: getRunsError } =
					await indexedDb.runs.getByTransformationId(transformation.id);

				if (getRunsError) {
					console.warn(
						`Failed to get runs for transformation ${transformation.id}`,
						getRunsError,
					);
					continue;
				}

				if (!runs || runs.length === 0) continue;

				for (const run of runs) {
					// Idempotent check: if already migrated, skip
					const { data: existing } = await fileSystemDb.runs.getById(run.id);
					if (existing) {
						continue;
					}

					// Write run directly to preserve all data including ID
					const { error } = await tryAsync({
						try: async () => {
							const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

							// Ensure directory exists
							const dirExists = await exists(runsPath);
							if (!dirExists) {
								await mkdir(runsPath, { recursive: true });
							}

							// Write run file
							const mdContent = matter.stringify('', run);
							const mdPath = await join(runsPath, `${run.id}.md`);
							const tmpPath = `${mdPath}.tmp`;

							await writeTextFile(tmpPath, mdContent);
							await rename(tmpPath, mdPath);
						},
						catch: (error) =>
							DbServiceErr({
								message: `Failed to migrate transformation run ${run.id}`,
								cause: error,
							}),
					});

					if (error) {
						console.warn(`Failed to migrate run ${run.id}`, error);
					}
				}
			}

			console.log('Runs migration complete');
		},
		catch: (error) =>
			DbServiceErr({
				message:
					'Failed to migrate transformation runs from IndexedDB to file system',
				cause: error,
			}),
	});
}
