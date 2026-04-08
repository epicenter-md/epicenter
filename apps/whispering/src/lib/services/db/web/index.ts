import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { DownloadService } from '$lib/services/download';

import type {
	Recording,
	Transformation,
	TransformationRun,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationStepRunCompleted,
	TransformationStepRunFailed,
	TransformationStepRunRunning,
} from '../models';
import type { DbService } from '../types';
import { DbError } from '../types';
import { blobToSerializedAudio, WhisperingDatabase } from './dexie-database';
import type { RecordingsDbSchemaV5, SerializedAudio } from './dexie-schemas';

// const downloadIndexedDbBlobWithToast = useDownloadIndexedDbBlobWithToast();

/**
 * Convert serialized audio back to Blob for use in the application.
 */
function serializedAudioToBlob(serializedAudio: SerializedAudio): Blob {
	return new Blob([serializedAudio.arrayBuffer], {
		type: serializedAudio.blobType,
	});
}

/**
 * Cache for audio object URLs to avoid recreating them.
 * Maps recordingId -> object URL
 */
const audioUrlCache = new Map<string, string>();

export function createDbServiceWeb({
	DownloadService,
}: {
	DownloadService: DownloadService;
}): DbService {
	const db = new WhisperingDatabase({ DownloadService });
	return {
		recordings: {
			getAll: async () => {
				return tryAsync({
					try: async () => {
						const recordings = await db.recordings
							.orderBy('timestamp')
							.reverse()
							.toArray();
						// Strip serializedAudio field to return Recording type
						return recordings.map(
							({ serializedAudio, ...recording }) => recording,
						);
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			getLatest: async () => {
				return tryAsync({
					try: async () => {
						const latestRecording = await db.recordings
							.orderBy('timestamp')
							.reverse()
							.first();
						if (!latestRecording) return null;
						// Strip serializedAudio field to return Recording type
						const { serializedAudio, ...recording } = latestRecording;
						return recording;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			getTranscribingIds: async () => {
				return tryAsync({
					try: () =>
						db.recordings
							.where('transcriptionStatus')
							.equals('TRANSCRIBING' satisfies Recording['transcriptionStatus'])
							.primaryKeys(),
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			getById: async (id) => {
				return tryAsync({
					try: async () => {
						const maybeRecording = await db.recordings.get(id);
						if (!maybeRecording) return null;
						// Strip serializedAudio field to return Recording type
						const { serializedAudio, ...recording } = maybeRecording;
						return recording;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async create(paramsOrParamsArray) {
				const paramsArray = Array.isArray(paramsOrParamsArray)
					? paramsOrParamsArray
					: [paramsOrParamsArray];

				const dbRecordings: RecordingsDbSchemaV5['recordings'][] =
					await Promise.all(
						paramsArray.map(async ({ recording, audio }) => ({
							...recording,
							serializedAudio: await blobToSerializedAudio(audio),
						})),
					);

				return tryAsync({
					try: async () => {
						await db.recordings.bulkAdd(dbRecordings);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			update: async (recording) => {
				const now = new Date().toISOString();
				const recordingWithTimestamp = {
					...recording,
					updatedAt: now,
				} satisfies Recording;

				// Get existing record to preserve serializedAudio (audio is immutable)
				const existingRecord = await db.recordings.get(recording.id);
				const serializedAudio = existingRecord?.serializedAudio;

				// Create updated IndexedDB record with preserved audio
				const dbRecording = {
					...recordingWithTimestamp,
					serializedAudio,
				};

				const { error: updateRecordingError } = await tryAsync({
					try: async () => {
						await db.recordings.put(dbRecording);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
				if (updateRecordingError) return Err(updateRecordingError);
				return Ok(recordingWithTimestamp);
			},

			delete: async (recordingOrRecordings) => {
				const recordings = Array.isArray(recordingOrRecordings)
					? recordingOrRecordings
					: [recordingOrRecordings];
				const ids = recordings.map((r) => r.id);
				return tryAsync({
					try: () => db.recordings.bulkDelete(ids),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			/**
			 * Checks and deletes expired recordings based on current settings.
			 * This should be called:
			 * 1. On initial load
			 * 2. Before adding new recordings
			 * 3. When retention settings change
			 */
			cleanupExpired: async ({
				recordingRetentionStrategy,
				maxRecordingCount,
			}: {
				recordingRetentionStrategy: 'keep-forever' | 'limit-count';
				maxRecordingCount: number;
			}) => {
				switch (recordingRetentionStrategy) {
					case 'keep-forever': {
						return Ok(undefined);
					}
					case 'limit-count': {
						const { data: count, error: countError } = await tryAsync({
							try: () => db.recordings.count(),
							catch: (error) => DbError.QueryFailed({ cause: error }),
						});
						if (countError) return Err(countError);
						if (count === 0) return Ok(undefined);

						if (count <= maxRecordingCount) return Ok(undefined);

						return tryAsync({
							try: async () => {
								const idsToDelete = await db.recordings
									.orderBy('createdAt')
									.limit(count - maxRecordingCount)
									.primaryKeys();
								await db.recordings.bulkDelete(idsToDelete);
							},
							catch: (error) => DbError.MutationFailed({ cause: error }),
						});
					}
				}
			},

			getAudioBlob: async (recordingId) => {
				return tryAsync({
					try: async () => {
						const recordingWithAudio = await db.recordings.get(recordingId);

						if (!recordingWithAudio) {
							throw new Error(`Recording ${recordingId} not found`);
						}

						if (!recordingWithAudio.serializedAudio) {
							throw new Error(`No audio found for recording ${recordingId}`);
						}

						const blob = serializedAudioToBlob(
							recordingWithAudio.serializedAudio,
						);
						return blob;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			ensureAudioPlaybackUrl: async (recordingId) => {
				return tryAsync({
					try: async () => {
						// Check cache first
						const cachedUrl = audioUrlCache.get(recordingId);
						if (cachedUrl) {
							return cachedUrl;
						}

						// Fetch blob from IndexedDB
						const recordingWithAudio = await db.recordings.get(recordingId);

						if (!recordingWithAudio) {
							throw new Error(`Recording ${recordingId} not found`);
						}

						if (!recordingWithAudio.serializedAudio) {
							throw new Error(`No audio found for recording ${recordingId}`);
						}

						const blob = serializedAudioToBlob(
							recordingWithAudio.serializedAudio,
						);
						const objectUrl = URL.createObjectURL(blob);
						audioUrlCache.set(recordingId, objectUrl);

						return objectUrl;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			revokeAudioUrl: (recordingId) => {
				const url = audioUrlCache.get(recordingId);
				if (url) {
					URL.revokeObjectURL(url);
					audioUrlCache.delete(recordingId);
				}
			},

			clear: async () => {
				return tryAsync({
					try: () => db.recordings.clear(),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			getCount: async () => {
				return tryAsync({
					try: () => db.recordings.count(),
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},
		}, // End of recordings namespace

		transformations: {
			getAll: async () => {
				return tryAsync({
					try: () => db.transformations.toArray(),
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			getById: async (id) => {
				return tryAsync({
					try: async () => {
						const maybeTransformation =
							(await db.transformations.get(id)) ?? null;
						return maybeTransformation;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			create: async (transformationOrTransformations) => {
				const transformations = Array.isArray(transformationOrTransformations)
					? transformationOrTransformations
					: [transformationOrTransformations];
				return tryAsync({
					try: async () => {
						await db.transformations.bulkAdd(transformations);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			update: async (transformation) => {
				const now = new Date().toISOString();
				const transformationWithTimestamp = {
					...transformation,
					updatedAt: now,
				} satisfies Transformation;
				const { error: updateTransformationError } = await tryAsync({
					try: () => db.transformations.put(transformationWithTimestamp),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
				if (updateTransformationError) return Err(updateTransformationError);
				return Ok(transformationWithTimestamp);
			},

			delete: async (transformationOrTransformations) => {
				const transformations = Array.isArray(transformationOrTransformations)
					? transformationOrTransformations
					: [transformationOrTransformations];
				return tryAsync({
					try: async () => {
						const ids = transformations.map((t) => t.id);
						await db.transformations.bulkDelete(ids);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			clear: async () => {
				return tryAsync({
					try: () => db.transformations.clear(),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			getCount: async () => {
				return tryAsync({
					try: () => db.transformations.count(),
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},
		}, // End of transformations namespace

		runs: {
			getAll: async () => {
				return tryAsync({
					try: async () => {
						const runs = await db.transformationRuns.toArray();
						return runs ?? [];
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			getById: async (id) => {
				const {
					data: transformationRun,
					error: getTransformationRunByIdError,
				} = await tryAsync({
					try: () => db.transformationRuns.where('id').equals(id).first(),
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
				if (getTransformationRunByIdError)
					return Err(getTransformationRunByIdError);
				return Ok(transformationRun ?? null);
			},

			getByTransformationId: async (transformationId) => {
				return tryAsync({
					try: async () => {
						const runs = await db.transformationRuns
							.where('transformationId')
							.equals(transformationId)
							.reverse()
							.toArray();

						if (!runs) return [];

						return runs.sort(
							(a, b) =>
								new Date(b.startedAt).getTime() -
								new Date(a.startedAt).getTime(),
						);
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			getByRecordingId: async (recordingId) => {
				return tryAsync({
					try: async () => {
						const runs = await db.transformationRuns
							.where('recordingId')
							.equals(recordingId)
							.toArray();

						if (!runs) return [];

						return runs.sort(
							(a, b) =>
								new Date(b.startedAt).getTime() -
								new Date(a.startedAt).getTime(),
						);
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			create: async (runOrRuns) => {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						await db.transformationRuns.bulkAdd(runs);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			addStep: async (run, step) => {
				const now = new Date().toISOString();
				const newTransformationStepRun = {
					id: nanoid(),
					stepId: step.id,
					input: step.input,
					startedAt: now,
					completedAt: null,
					status: 'running',
				} satisfies TransformationStepRunRunning;

				const updatedRun: TransformationRun = {
					...run,
					stepRuns: [...run.stepRuns, newTransformationStepRun],
				};

				const { error: addStepRunToTransformationRunError } = await tryAsync({
					try: () => db.transformationRuns.put(updatedRun),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
				if (addStepRunToTransformationRunError)
					return Err(addStepRunToTransformationRunError);

				return Ok(newTransformationStepRun);
			},

			failStep: async (run, stepRunId, error) => {
				const now = new Date().toISOString();

				// Create the failed transformation run
				const failedRun: TransformationRunFailed = {
					...run,
					status: 'failed',
					completedAt: now,
					error,
					stepRuns: run.stepRuns.map((stepRun) => {
						if (stepRun.id === stepRunId) {
							const failedStepRun: TransformationStepRunFailed = {
								...stepRun,
								status: 'failed',
								completedAt: now,
								error,
							};
							return failedStepRun;
						}
						return stepRun;
					}),
				};

				const { error: updateTransformationStepRunError } = await tryAsync({
					try: () => db.transformationRuns.put(failedRun),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
				if (updateTransformationStepRunError)
					return Err(updateTransformationStepRunError);

				return Ok(failedRun);
			},

			completeStep: async (run, stepRunId, output) => {
				const now = new Date().toISOString();

				// Create updated transformation run with the new step runs
				const updatedRun: TransformationRun = {
					...run,
					stepRuns: run.stepRuns.map((stepRun) => {
						if (stepRun.id === stepRunId) {
							const completedStepRun: TransformationStepRunCompleted = {
								...stepRun,
								status: 'completed',
								completedAt: now,
								output,
							};
							return completedStepRun;
						}
						return stepRun;
					}),
				};

				const { error: updateTransformationStepRunError } = await tryAsync({
					try: () => db.transformationRuns.put(updatedRun),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
				if (updateTransformationStepRunError)
					return Err(updateTransformationStepRunError);

				return Ok(updatedRun);
			},

			complete: async (run, output) => {
				const now = new Date().toISOString();

				// Create the completed transformation run
				const completedRun: TransformationRunCompleted = {
					...run,
					status: 'completed',
					completedAt: now,
					output,
				};

				const { error: updateTransformationStepRunError } = await tryAsync({
					try: () => db.transformationRuns.put(completedRun),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
				if (updateTransformationStepRunError)
					return Err(updateTransformationStepRunError);

				return Ok(completedRun);
			},

			delete: async (runOrRuns) => {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						const runIds = runs.map((run) => run.id);
						await db.transformationRuns.bulkDelete(runIds);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			clear: async () => {
				return tryAsync({
					try: () => db.transformationRuns.clear(),
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			getCount: async () => {
				return tryAsync({
					try: () => db.transformationRuns.count(),
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},
		}, // End of runs namespace
	};
}
