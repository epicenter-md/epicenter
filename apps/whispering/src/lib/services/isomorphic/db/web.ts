import Dexie, { type Transaction } from 'dexie';
import { nanoid } from 'nanoid/non-secure';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { moreDetailsDialog } from '$lib/components/MoreDetailsDialog.svelte';
import { rpc } from '$lib/query';
import type { DownloadService } from '$lib/services/isomorphic/download';
import type { Settings } from '$lib/settings';
import type {
	CustomSound,
	Recording,
	RecordingsDbSchemaV1,
	RecordingsDbSchemaV2,
	RecordingsDbSchemaV3,
	RecordingsDbSchemaV4,
	RecordingsDbSchemaV5,
	SerializedAudio,
	Transformation,
	TransformationRun,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationStepRunCompleted,
	TransformationStepRunFailed,
	TransformationStepRunRunning,
	TransformationStepV2,
	TransformationV1,
} from './models';
import type { DbService } from './types';
import { DbServiceErr } from './types';

const DB_NAME = 'RecordingDB';

class WhisperingDatabase extends Dexie {
	recordings!: Dexie.Table<RecordingsDbSchemaV5['recordings'], string>;
	transformations!: Dexie.Table<Transformation, string>;
	transformationRuns!: Dexie.Table<TransformationRun, string>;
	customSounds!: Dexie.Table<CustomSound, string>;

	constructor({ DownloadService }: { DownloadService: DownloadService }) {
		super(DB_NAME);

		const wrapUpgradeWithErrorHandling = async ({
			tx,
			version,
			upgrade,
		}: {
			tx: Transaction;
			version: number;
			upgrade: (tx: Transaction) => Promise<void>;
		}) => {
			try {
				await upgrade(tx);
			} catch (error) {
				const DUMP_TABLE_NAMES = [
					'recordings',
					'recordingMetadata',
					'recordingBlobs',
				] as const;

				const dumpTable = async (tableName: string) => {
					try {
						const contents = await tx.table(tableName).toArray();
						return contents;
					} catch (_error) {
						return [];
					}
				};

				const dumps = await Dexie.waitFor(
					Promise.all(DUMP_TABLE_NAMES.map((name) => dumpTable(name))),
				);

				const dumpState = {
					version,
					tables: Object.fromEntries(
						DUMP_TABLE_NAMES.map((name, i) => [name, dumps[i]]),
					),
				};

				const dumpString = JSON.stringify(dumpState, null, 2);

				moreDetailsDialog.open({
					title: `Failed to upgrade IndexedDb Database to version ${version}`,
					description:
						'Please download the database dump and delete the database to start fresh.',
					content: dumpString,
					buttons: [
						{
							label: 'Download Database Dump',
							onClick: async () => {
								const blob = new Blob([dumpString], {
									type: 'application/json',
								});
								const { error: downloadError } =
									await DownloadService.downloadBlob({
										name: 'recording-db-dump.json',
										blob,
									});
								if (downloadError) {
									rpc.notify.error.execute({
										title: 'Failed to download IndexedDB dump!',
										description: 'Your IndexedDB dump could not be downloaded.',
										action: { type: 'more-details', error: downloadError },
									});
								} else {
									rpc.notify.success.execute({
										title: 'IndexedDB dump downloaded!',
										description: 'Your IndexedDB dump is being downloaded.',
									});
								}
							},
						},
						{
							label: 'Delete Database and Reload',
							variant: 'destructive',
							onClick: async () => {
								try {
									// Delete the database
									await this.delete();
									rpc.notify.success.execute({
										title: 'Database Deleted',
										description:
											'The database has been successfully deleted. Please refresh the page.',
										action: {
											type: 'button',
											label: 'Refresh',
											onClick: () => {
												window.location.reload();
											},
										},
									});
								} catch (err) {
									const error = extractErrorMessage(err);

									rpc.notify.error.execute({
										title: 'Failed to Delete Database',
										description:
											'There was an error deleting the database. Please try again.',
										action: {
											type: 'more-details',
											error,
										},
									});
								}
							},
						},
					],
				});

				throw error; // Re-throw to trigger rollback
			}
		};

		// V1: Single recordings table
		this.version(0.1).stores({ recordings: '&id, timestamp' });

		// V2: Split into metadata and blobs
		this.version(0.2)
			.stores({
				recordings: null,
				recordingMetadata: '&id',
				recordingBlobs: '&id',
			})
			.upgrade(async (tx) => {
				await wrapUpgradeWithErrorHandling({
					tx,
					version: 0.2,
					upgrade: async (tx) => {
						// Migrate data from recordings to split tables
						const oldRecordings = await tx
							.table<RecordingsDbSchemaV1['recordings']>('recordings')
							.toArray();

						// Create entries in both new tables
						const metadata = oldRecordings.map(
							({ blob, ...recording }) => recording,
						);
						const blobs = oldRecordings.map(({ id, blob }) => ({ id, blob }));

						await tx
							.table<RecordingsDbSchemaV2['recordingMetadata']>(
								'recordingMetadata',
							)
							.bulkAdd(metadata);
						await tx
							.table<RecordingsDbSchemaV2['recordingBlobs']>('recordingBlobs')
							.bulkAdd(blobs);
					},
				});
			});

		// V3: Back to single recordings table
		this.version(0.3)
			.stores({
				recordings: '&id, timestamp',
				recordingMetadata: null,
				recordingBlobs: null,
			})
			.upgrade(async (tx) => {
				await wrapUpgradeWithErrorHandling({
					tx,
					version: 0.3,
					upgrade: async (tx) => {
						// Get data from both tables
						const metadata = await tx
							.table<RecordingsDbSchemaV2['recordingMetadata']>(
								'recordingMetadata',
							)
							.toArray();
						const blobs = await tx
							.table<RecordingsDbSchemaV2['recordingBlobs']>('recordingBlobs')
							.toArray();

						// Combine and migrate the data
						const mergedRecordings = metadata.map((record) => {
							const blob = blobs.find((b) => b.id === record.id)?.blob;
							return { ...record, blob };
						});

						await tx
							.table<RecordingsDbSchemaV3['recordings']>('recordings')
							.bulkAdd(mergedRecordings);
					},
				});
			});

		// V4: Add transformations, transformation runs, and recording
		// Also migrate recordings timestamp to createdAt and updatedAt
		this.version(0.4)
			.stores({
				recordings: '&id, timestamp, createdAt, updatedAt',
				transformations: '&id, createdAt, updatedAt',
				transformationRuns: '&id, transformationId, recordingId, startedAt',
			})
			.upgrade(async (tx) => {
				await wrapUpgradeWithErrorHandling({
					tx,
					version: 0.4,
					upgrade: async (tx) => {
						const oldRecordings = await tx
							.table<RecordingsDbSchemaV3['recordings']>('recordings')
							.toArray();

						const newRecordings = oldRecordings.map(
							(record) =>
								({
									...record,
									createdAt: record.timestamp,
									updatedAt: record.timestamp,
								}) satisfies RecordingsDbSchemaV4['recordings'],
						);

						await tx.table('recordings').clear();
						await tx
							.table<RecordingsDbSchemaV4['recordings']>('recordings')
							.bulkAdd(newRecordings);
					},
				});
			});

		// V5: Save recording blob as ArrayBuffer
		this.version(0.5)
			.stores({
				recordings: '&id, timestamp, createdAt, updatedAt',
				transformations: '&id, createdAt, updatedAt',
				transformationRuns: '&id, transformationId, recordingId, startedAt',
			})
			.upgrade(async (tx) => {
				await wrapUpgradeWithErrorHandling({
					tx,
					version: 0.5,
					upgrade: async (tx) => {
						const oldRecordings = await tx
							.table<RecordingsDbSchemaV4['recordings']>('recordings')
							.toArray();

						const newRecordings = await Dexie.waitFor(
							Promise.all(
								oldRecordings.map(async (record) => {
									// Convert V4 (Recording with blob) to V5 (RecordingStoredInIndexedDB)
									const { blob, ...recordWithoutBlob } = record;
									const serializedAudio = blob
										? (await blobToSerializedAudio(blob)).data ?? undefined
										: undefined;
									return {
										...recordWithoutBlob,
										serializedAudio,
									} satisfies RecordingsDbSchemaV5['recordings'];
								}),
							),
						);

						await Dexie.waitFor(tx.table('recordings').clear());
						await Dexie.waitFor(
							tx
								.table<RecordingsDbSchemaV5['recordings']>('recordings')
								.bulkAdd(newRecordings),
						);
					},
				});
			});

		// V6: Migrate transformation steps to version 2 schema
		// - Adds version field (set to 2)
		// - Adds Custom.model and Custom.baseUrl fields for local LLM endpoints
		// This matches the versioned schema in transformations.ts
		//
		// Note: TransformationV1 is a TypeScript type hint only; Dexie returns raw data.
		// Old steps in IndexedDB won't have a `version` field at all. The spread `...step`
		// preserves all existing fields, then we explicitly set version=2 and the new
		// Custom fields. Any existing `version` field (if somehow present) gets overwritten
		// to 2, which is correct since we're migrating everything to V2.
		this.version(0.6)
			.stores({
				recordings: '&id, timestamp, createdAt, updatedAt',
				transformations: '&id, createdAt, updatedAt',
				transformationRuns: '&id, transformationId, recordingId, startedAt',
			})
			.upgrade(async (tx) => {
				await wrapUpgradeWithErrorHandling({
					tx,
					version: 0.6,
					upgrade: async (tx) => {
						// TransformationV1 is just a type hint; Dexie returns raw unvalidated data
						const transformations = await tx
							.table<TransformationV1>('transformations')
							.toArray();

						for (const transformation of transformations) {
							const updatedSteps: TransformationStepV2[] =
								transformation.steps.map((step) => ({
									...step,
									// Explicitly set V2 fields (overwrites any existing values)
									version: 2 as const,
									'prompt_transform.inference.provider.Custom.model': '',
									'prompt_transform.inference.provider.Custom.baseUrl': '',
								}));

							await tx
								.table<Transformation>('transformations')
								.update(transformation.id, { steps: updatedSteps });
						}
					},
				});
			});

		// V7: Add customSounds table for custom notification sounds
		this.version(0.7).stores({
			recordings: '&id, timestamp, createdAt, updatedAt',
			transformations: '&id, createdAt, updatedAt',
			transformationRuns: '&id, transformationId, recordingId, startedAt',
			customSounds: '&id',
		});
	}
}

// const downloadIndexedDbBlobWithToast = useDownloadIndexedDbBlobWithToast();

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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting all recordings from Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting latest recording from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			getTranscribingIds: async () => {
				return tryAsync({
					try: () =>
						db.recordings
							.where('transcriptionStatus')
							.equals('TRANSCRIBING' satisfies Recording['transcriptionStatus'])
							.primaryKeys(),
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transcribing recording ids from Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting recording by id from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async create(paramsOrParamsArray) {
				const paramsArray = Array.isArray(paramsOrParamsArray)
					? paramsOrParamsArray
					: [paramsOrParamsArray];

				const dbRecordingsResults = await Promise.all(
					paramsArray.map(async ({ recording, audio }) => {
						const { data: serializedAudio, error } =
							await blobToSerializedAudio(audio);
						if (error) return { error };
						return {
							data: {
								...recording,
								serializedAudio,
							} satisfies RecordingsDbSchemaV5['recordings'],
						};
					}),
				);

				// Check for any serialization errors
				const firstError = dbRecordingsResults.find((r) => r.error)?.error;
				if (firstError) {
					return DbServiceErr({
						message: `Error serializing audio for recording: ${firstError.message}`,
					});
				}

				const dbRecordings = dbRecordingsResults.map(
					(r) => r.data as RecordingsDbSchemaV5['recordings'],
				);

				return tryAsync({
					try: async () => {
						await db.recordings.bulkAdd(dbRecordings);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error adding recording(s) to Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error updating recording in Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting recording(s) from Dexie: ${extractErrorMessage(error)}`,
						}),
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
				recordingRetentionStrategy: Settings['database.recordingRetentionStrategy'];
				maxRecordingCount: Settings['database.maxRecordingCount'];
			}) => {
				switch (recordingRetentionStrategy) {
					case 'keep-forever': {
						return Ok(undefined);
					}
					case 'limit-count': {
						const { data: count, error: countError } = await tryAsync({
							try: () => db.recordings.count(),
							catch: (error) =>
								DbServiceErr({
									message: `Unable to get recording count while cleaning up old recordings: ${extractErrorMessage(error)}`,
								}),
						});
						if (countError) return Err(countError);
						if (count === 0) return Ok(undefined);

						const maxCount = Number.parseInt(maxRecordingCount, 10);

						if (count <= maxCount) return Ok(undefined);

						return tryAsync({
							try: async () => {
								const idsToDelete = await db.recordings
									.orderBy('createdAt')
									.limit(count - maxCount)
									.primaryKeys();
								await db.recordings.bulkDelete(idsToDelete);
							},
							catch: (error) =>
								DbServiceErr({
									message: `Unable to clean up old recordings: ${extractErrorMessage(error)}`,
								}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting audio blob from IndexedDB: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error ensuring audio playback URL from IndexedDB: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error clearing recordings from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			getCount: async () => {
				return tryAsync({
					try: () => db.recordings.count(),
					catch: (error) =>
						DbServiceErr({
							message: `Error getting recordings count from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},
		}, // End of recordings namespace

		transformations: {
			getAll: async () => {
				return tryAsync({
					try: () => db.transformations.toArray(),
					catch: (error) =>
						DbServiceErr({
							message: `Error getting all transformations from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			getById: async (id) => {
				return tryAsync({
					try: async () => {
						const maybeTransformation =
							(await db.transformations.get(id)) ?? null;
						return maybeTransformation;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation by id from Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error adding transformation(s) to Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error updating transformation in Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting transformation(s) from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			clear: async () => {
				return tryAsync({
					try: () => db.transformations.clear(),
					catch: (error) =>
						DbServiceErr({
							message: `Error clearing transformations from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			getCount: async () => {
				return tryAsync({
					try: () => db.transformations.count(),
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformations count from Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting all transformation runs from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			getById: async (id) => {
				const {
					data: transformationRun,
					error: getTransformationRunByIdError,
				} = await tryAsync({
					try: () => db.transformationRuns.where('id').equals(id).first(),
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation run by id from Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation runs by transformation id from Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation runs by recording id from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			create: async (runOrRuns) => {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						await db.transformationRuns.bulkAdd(runs);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error adding transformation run(s) to Dexie: ${extractErrorMessage(error)}`,
						}),
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

				const updatedRun = {
					...run,
					stepRuns: [...run.stepRuns, newTransformationStepRun],
				} satisfies TransformationRun;

				const { error: addStepRunToTransformationRunError } = await tryAsync({
					try: () => db.transformationRuns.put(updatedRun),
					catch: (error) =>
						DbServiceErr({
							message: `Error adding step run to transformation run in Dexie: ${extractErrorMessage(error)}`,
						}),
				});
				if (addStepRunToTransformationRunError)
					return Err(addStepRunToTransformationRunError);

				return Ok(newTransformationStepRun);
			},

			failStep: async (run, stepRunId, error) => {
				const now = new Date().toISOString();

				// Create the failed transformation run
				const failedRun = {
					...run,
					status: 'failed',
					completedAt: now,
					error,
					stepRuns: run.stepRuns.map((stepRun) => {
						if (stepRun.id === stepRunId) {
							const failedStepRun = {
								...stepRun,
								status: 'failed',
								completedAt: now,
								error,
							} satisfies TransformationStepRunFailed;
							return failedStepRun;
						}
						return stepRun;
					}),
				} satisfies TransformationRunFailed;

				const { error: updateTransformationStepRunError } = await tryAsync({
					try: () => db.transformationRuns.put(failedRun),
					catch: (error) =>
						DbServiceErr({
							message: `Error updating transformation run as failed in Dexie: ${extractErrorMessage(error)}`,
						}),
				});
				if (updateTransformationStepRunError)
					return Err(updateTransformationStepRunError);

				return Ok(failedRun);
			},

			completeStep: async (run, stepRunId, output) => {
				const now = new Date().toISOString();

				// Create updated transformation run with the new step runs
				const updatedRun = {
					...run,
					stepRuns: run.stepRuns.map((stepRun) => {
						if (stepRun.id === stepRunId) {
							const completedStepRun = {
								...stepRun,
								status: 'completed',
								completedAt: now,
								output,
							} satisfies TransformationStepRunCompleted;
							return completedStepRun;
						}
						return stepRun;
					}),
				} satisfies TransformationRun;

				const { error: updateTransformationStepRunError } = await tryAsync({
					try: () => db.transformationRuns.put(updatedRun),
					catch: (error) =>
						DbServiceErr({
							message: `Error updating transformation step run status in Dexie: ${extractErrorMessage(error)}`,
						}),
				});
				if (updateTransformationStepRunError)
					return Err(updateTransformationStepRunError);

				return Ok(updatedRun);
			},

			complete: async (run, output) => {
				const now = new Date().toISOString();

				// Create the completed transformation run
				const completedRun = {
					...run,
					status: 'completed',
					completedAt: now,
					output,
				} satisfies TransformationRunCompleted;

				const { error: updateTransformationStepRunError } = await tryAsync({
					try: () => db.transformationRuns.put(completedRun),
					catch: (error) =>
						DbServiceErr({
							message: `Error updating transformation run as completed in Dexie: ${extractErrorMessage(error)}`,
						}),
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
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting transformation run(s) from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			clear: async () => {
				return tryAsync({
					try: () => db.transformationRuns.clear(),
					catch: (error) =>
						DbServiceErr({
							message: `Error clearing transformation runs from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},

			getCount: async () => {
				return tryAsync({
					try: () => db.transformationRuns.count(),
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation runs count from Dexie: ${extractErrorMessage(error)}`,
						}),
				});
			},
		}, // End of runs namespace

		sounds: {
			async get(soundId) {
				return tryAsync({
					try: async () => {
						const customSound = await db.customSounds.get(soundId);
						if (!customSound) return null;

						return serializedAudioToBlob(customSound.serializedAudio);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting custom sound from Dexie (soundId: ${soundId}): ${extractErrorMessage(error)}`,
						}),
				});
			},

			async save(soundId, file) {
				const { data: serializedAudio, error: serializeError } =
					await blobToSerializedAudio(file);
				if (serializeError) {
					return DbServiceErr({
						message: `Error serializing custom sound (soundId: ${soundId}): ${serializeError.message}`,
					});
				}

				return tryAsync({
					try: async () => {
						const customSound = {
							id: soundId,
							serializedAudio,
						} satisfies CustomSound;
						await db.customSounds.put(customSound);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error saving custom sound to Dexie (soundId: ${soundId}): ${extractErrorMessage(error)}`,
						}),
				});
			},

			async delete(soundId) {
				return tryAsync({
					try: () => db.customSounds.delete(soundId),
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting custom sound from Dexie (soundId: ${soundId}): ${extractErrorMessage(error)}`,
						}),
				});
			},
		},
	};
}

const { BlobSerializationErr } = createTaggedError('BlobSerializationError');

/**
 * Convert Blob to serialized format for IndexedDB storage.
 */
async function blobToSerializedAudio(blob: Blob) {
	return tryAsync({
		try: async () => {
			const arrayBuffer = await blob.arrayBuffer();
			return { arrayBuffer, blobType: blob.type } satisfies SerializedAudio;
		},
		catch: (error) =>
			BlobSerializationErr({
				message: `Failed to serialize blob to ArrayBuffer: ${extractErrorMessage(error)}`,
			}),
	});
}

/**
 * Convert serialized audio back to Blob for use in the application.
 */
function serializedAudioToBlob(serializedAudio: SerializedAudio): Blob {
	return new Blob([serializedAudio.arrayBuffer], {
		type: serializedAudio.blobType,
	});
}
