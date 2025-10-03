import { moreDetailsDialog } from '$lib/components/MoreDetailsDialog.svelte';
import { rpc } from '$lib/query';
import type { DownloadService } from '$lib/services/download';
import type { Settings } from '$lib/settings';
import Dexie, { type Transaction } from 'dexie';
import { nanoid } from 'nanoid/non-secure';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';

import type {
	Recording,
	RecordingsDbSchemaV1,
	RecordingsDbSchemaV2,
	RecordingsDbSchemaV3,
	RecordingsDbSchemaV4,
	RecordingsDbSchemaV5,
	Transformation,
	TransformationRun,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationRunRunning,
	TransformationStepRun,
	TransformationStepRunCompleted,
	TransformationStepRunFailed,
	TransformationStepRunRunning,
	CustomSound,
} from './models';

export const { DbServiceError, DbServiceErr } =
	createTaggedError('DbServiceError');
export type DbServiceError = ReturnType<typeof DbServiceError>;

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
					} catch (error) {
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

						const newRecordings = oldRecordings.map((record) => ({
							...record,
							createdAt: record.timestamp,
							updatedAt: record.timestamp,
						}));

						await tx.table('recordings').clear();
						await tx.table('recordings').bulkAdd(newRecordings);
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
									const recordingWithSerializedAudio =
										await recordingToRecordingWithSerializedAudio(record);
									return recordingWithSerializedAudio;
								}),
							),
						);

						await Dexie.waitFor(tx.table('recordings').clear());
						await Dexie.waitFor(tx.table('recordings').bulkAdd(newRecordings));
					},
				});
			});

			// V7: Create custom sounds table
			this.version(0.7)
			.stores({
				recordings: '&id, timestamp, createdAt, updatedAt',
				transformations: '&id, createdAt, updatedAt',
				transformationRuns: '&id, transformationId, recordingId, startedAt',
				customSounds: '&id, uploadedAt, updatedAt',
			})
			.upgrade(async (tx) => {
				console.log('🔧 DB: Upgrading to version 0.7 - creating new customSounds table');
			});
	
		// V6: Change the "subtitle" field to "description"
		// this.version(5)
		// 	.stores({
		// 		recordings: '&id, timestamp, createdAt, updatedAt',
		// 		transformations: '&id, createdAt, updatedAt',
		// 		transformationRuns: '&id, recordingId, startedAt',
		// 	})
		// 	.upgrade(async (tx) => {
		// 		const oldRecordings = await tx
		// 			.table<RecordingsDbSchemaV5['recordings']>('recordings')
		// 			.toArray();

		// 		const newRecordings = oldRecordings.map(
		// 			({ subtitle, ...recording }) => ({
		// 				...recording,
		// 				description: subtitle,
		// 			}),
		// 		);

		// 		await tx.table('recordings').bulkAdd(newRecordings);
		// 	});
	}
}

// const downloadIndexedDbBlobWithToast = useDownloadIndexedDbBlobWithToast();

const recordingToRecordingWithSerializedAudio = async (
	recording: Recording,
): Promise<RecordingsDbSchemaV5['recordings']> => {
	const { blob, ...rest } = recording;
	if (!blob) return { ...rest, serializedAudio: undefined };

	const arrayBuffer = await blob.arrayBuffer().catch((error) => {
		console.error('Error getting array buffer from blob', blob, error);
		return undefined;
	});
	if (!arrayBuffer) return { ...rest, serializedAudio: undefined };

	return { ...rest, serializedAudio: { arrayBuffer, blobType: blob.type } };
};

const recordingWithSerializedAudioToRecording = (
	recording: RecordingsDbSchemaV5['recordings'],
): Recording => {
	const { serializedAudio, ...rest } = recording;
	if (!serializedAudio) return { ...rest, blob: undefined };

	const { arrayBuffer, blobType } = serializedAudio;

	const blob = new Blob([arrayBuffer], { type: blobType });

	return { ...rest, blob };
};

export function createDbServiceDexie({
	DownloadService,
}: {
	DownloadService: DownloadService;
}) {
	const db = new WhisperingDatabase({ DownloadService });
	return {
		async getAllRecordings(): Promise<Result<Recording[], DbServiceError>> {
			return tryAsync({
				try: async () => {
					const recordings = await db.recordings
						.orderBy('timestamp')
						.reverse()
						.toArray();
					return Dexie.waitFor(
						Promise.all(
							recordings.map(recordingWithSerializedAudioToRecording),
						),
					);
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error getting all recordings from Dexie',
						cause: error,
					}),
			});
		},

		async getLatestRecording(): Promise<
			Result<Recording | null, DbServiceError>
		> {
			return tryAsync({
				try: async () => {
					const latestRecording = await db.recordings
						.orderBy('timestamp')
						.reverse()
						.first();
					if (!latestRecording) return null;
					return recordingWithSerializedAudioToRecording(latestRecording);
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error getting latest recording from Dexie',
						cause: error,
					}),
			});
		},

		async getTranscribingRecordingIds(): Promise<
			Result<string[], DbServiceError>
		> {
			return tryAsync({
				try: () =>
					db.recordings
						.where('transcriptionStatus')
						.equals('TRANSCRIBING' satisfies Recording['transcriptionStatus'])
						.primaryKeys(),
				catch: (error) =>
					DbServiceErr({
						message: 'Error getting transcribing recording ids from Dexie',
						cause: error,
					}),
			});
		},

		async getRecordingById(
			id: string,
		): Promise<Result<Recording | null, DbServiceError>> {
			return tryAsync({
				try: async () => {
					const maybeRecording = await db.recordings.get(id);
					if (!maybeRecording) return null;
					return recordingWithSerializedAudioToRecording(maybeRecording);
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error getting recording by id from Dexie',
						context: { id },
						cause: error,
					}),
			});
		},

		async createRecording(
			recording: Recording,
		): Promise<Result<Recording, DbServiceError>> {
			const now = new Date().toISOString();
			const recordingWithTimestamps = {
				...recording,
				createdAt: now,
				updatedAt: now,
			} satisfies Recording;

			const dbRecording = await recordingToRecordingWithSerializedAudio(
				recordingWithTimestamps,
			);

			const { error: createRecordingError } = await tryAsync({
				try: async () => {
					await db.recordings.add(dbRecording);
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error adding recording to Dexie',
						context: { recording },
						cause: error,
					}),
			});
			if (createRecordingError) return Err(createRecordingError);
			return Ok(recordingWithTimestamps);
		},

		async updateRecording(
			recording: Recording,
		): Promise<Result<Recording, DbServiceError>> {
			const now = new Date().toISOString();
			const recordingWithTimestamp = {
				...recording,
				updatedAt: now,
			} satisfies Recording;

			const dbRecording = await recordingToRecordingWithSerializedAudio(
				recordingWithTimestamp,
			);

			const { error: updateRecordingError } = await tryAsync({
				try: async () => {
					await db.recordings.put(dbRecording);
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error updating recording in Dexie',
						context: { recording },
						cause: error,
					}),
			});
			if (updateRecordingError) return Err(updateRecordingError);
			return Ok(recordingWithTimestamp);
		},

		async deleteRecording(
			recording: Recording,
		): Promise<Result<void, DbServiceError>> {
			const { error: deleteRecordingError } = await tryAsync({
				try: async () => {
					await db.recordings.delete(recording.id);
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error deleting recording from Dexie',
						context: { recording },
						cause: error,
					}),
			});
			if (deleteRecordingError) return Err(deleteRecordingError);
			return Ok(undefined);
		},

		async deleteRecordings(
			recordingsToDelete: Recording[],
		): Promise<Result<void, DbServiceError>> {
			const ids = recordingsToDelete.map((r) => r.id);
			const { error: deleteRecordingsError } = await tryAsync({
				try: () => db.recordings.bulkDelete(ids),
				catch: (error) =>
					DbServiceErr({
						message: 'Error deleting recordings from Dexie',
						context: { recordingsToDelete },
						cause: error,
					}),
			});
			if (deleteRecordingsError) return Err(deleteRecordingsError);
			return Ok(undefined);
		},

		/**
		 * Checks and deletes expired recordings based on current settings.
		 * This should be called:
		 * 1. On initial load
		 * 2. Before adding new recordings
		 * 3. When retention settings change
		 */
		async cleanupExpiredRecordings({
			recordingRetentionStrategy,
			maxRecordingCount,
		}: {
			recordingRetentionStrategy: Settings['database.recordingRetentionStrategy'];
			maxRecordingCount: Settings['database.maxRecordingCount'];
		}): Promise<Result<void, DbServiceError>> {
			switch (recordingRetentionStrategy) {
				case 'keep-forever': {
					return Ok(undefined);
				}
				case 'limit-count': {
					const { data: count, error: countError } = await tryAsync({
						try: () => db.recordings.count(),
						catch: (error) =>
							DbServiceErr({
								message:
									'Unable to get recording count while cleaning up old recordings',
								context: { maxRecordingCount, recordingRetentionStrategy },
								cause: error,
							}),
					});
					if (countError) return Err(countError);
					if (count === 0) return Ok(undefined);

					const maxCount = Number.parseInt(maxRecordingCount);

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
								message: 'Unable to clean up old recordings',
								context: { count, maxCount, recordingRetentionStrategy },
								cause: error,
							}),
					});
				}
			}
		},
		async getAllTransformations(): Promise<
			Result<Transformation[], DbServiceError>
		> {
			return tryAsync({
				try: () => db.transformations.toArray(),
				catch: (error) =>
					DbServiceErr({
						message: 'Error getting all transformations from Dexie',
						cause: error,
					}),
			});
		},

		async getTransformationById(
			id: string,
		): Promise<Result<Transformation | null, DbServiceError>> {
			return tryAsync({
				try: async () => {
					const maybeTransformation =
						(await db.transformations.get(id)) ?? null;
					return maybeTransformation;
				},
				catch: (error) =>
					DbServiceErr({
						message: 'Error getting transformation by id from Dexie',
						context: { id },
						cause: error,
					}),
			});
		},

		async createTransformation(
			transformation: Transformation,
		): Promise<Result<Transformation, DbServiceError>> {
			const { error: createTransformationError } = await tryAsync({
				try: () => db.transformations.add(transformation),
				catch: (error) =>
					DbServiceErr({
						message: 'Error adding transformation to Dexie',
						context: { transformation },
						cause: error,
					}),
			});
			if (createTransformationError) return Err(createTransformationError);
			return Ok(transformation);
		},

		async updateTransformation(
			transformation: Transformation,
		): Promise<Result<Transformation, DbServiceError>> {
			const now = new Date().toISOString();
			const transformationWithTimestamp = {
				...transformation,
				updatedAt: now,
			} satisfies Transformation;
			const { error: updateTransformationError } = await tryAsync({
				try: () => db.transformations.put(transformationWithTimestamp),
				catch: (error) =>
					DbServiceErr({
						message: 'Error updating transformation in Dexie',
						context: { transformation },
						cause: error,
					}),
			});
			if (updateTransformationError) return Err(updateTransformationError);
			return Ok(transformationWithTimestamp);
		},

		async deleteTransformation(
			transformation: Transformation,
		): Promise<Result<void, DbServiceError>> {
			const { error: deleteTransformationError } = await tryAsync({
				try: () => db.transformations.delete(transformation.id),
				catch: (error) =>
					DbServiceErr({
						message: 'Error deleting transformation from Dexie',
						context: { transformation },
						cause: error,
					}),
			});
			if (deleteTransformationError) return Err(deleteTransformationError);
			return Ok(undefined);
		},

		async deleteTransformations(
			transformations: Transformation[],
		): Promise<Result<void, DbServiceError>> {
			const ids = transformations.map((t) => t.id);
			const { error: deleteTransformationsError } = await tryAsync({
				try: () => db.transformations.bulkDelete(ids),
				catch: (error) =>
					DbServiceErr({
						message: 'Error deleting transformations from Dexie',
						context: { transformations },
						cause: error,
					}),
			});
			if (deleteTransformationsError) return Err(deleteTransformationsError);
			return Ok(undefined);
		},

		async getTransformationRunById(
			id: string,
		): Promise<Result<TransformationRun | null, DbServiceError>> {
			const { data: transformationRun, error: getTransformationRunByIdError } =
				await tryAsync({
					try: () => db.transformationRuns.where('id').equals(id).first(),
					catch: (error) =>
						DbServiceErr({
							message: 'Error getting transformation run by id from Dexie',
							context: { id },
							cause: error,
						}),
				});
			if (getTransformationRunByIdError)
				return Err(getTransformationRunByIdError);
			return Ok(transformationRun ?? null);
		},

		async getTransformationRunsByTransformationId(
			transformationId: string,
		): Promise<Result<TransformationRun[], DbServiceError>> {
			return tryAsync({
				try: () =>
					db.transformationRuns
						.where('transformationId')
						.equals(transformationId)
						.reverse()
						.toArray()
						.then((runs) =>
							runs.sort(
								(a, b) =>
									new Date(b.startedAt).getTime() -
									new Date(a.startedAt).getTime(),
							),
						),
				catch: (error) =>
					DbServiceErr({
						message:
							'Error getting transformation runs by transformation id from Dexie',
						context: { transformationId },
						cause: error,
					}),
			});
		},

		async getTransformationRunsByRecordingId(
			recordingId: string,
		): Promise<Result<TransformationRun[], DbServiceError>> {
			return tryAsync({
				try: () =>
					db.transformationRuns
						.where('recordingId')
						.equals(recordingId)
						.toArray()
						.then((runs) =>
							runs.sort(
								(a, b) =>
									new Date(b.startedAt).getTime() -
									new Date(a.startedAt).getTime(),
							),
						),
				catch: (error) =>
					DbServiceErr({
						message:
							'Error getting transformation runs by recording id from Dexie',
						context: { recordingId },
						cause: error,
					}),
			});
		},

		async createTransformationRun({
			transformationId,
			recordingId,
			input,
		}: {
			transformationId: string;
			recordingId: string | null;
			input: string;
		}): Promise<Result<TransformationRun, DbServiceError>> {
			const now = new Date().toISOString();
			const transformationRunWithTimestamps = {
				id: nanoid(),
				transformationId,
				recordingId,
				input,
				startedAt: now,
				completedAt: null,
				status: 'running',
				stepRuns: [],
			} satisfies TransformationRunRunning;
			const { error: createTransformationRunError } = await tryAsync({
				try: () => db.transformationRuns.add(transformationRunWithTimestamps),
				catch: (error) =>
					DbServiceErr({
						message: 'Error adding transformation run to Dexie',
						context: { transformationId, recordingId, input },
						cause: error,
					}),
			});
			if (createTransformationRunError)
				return Err(createTransformationRunError);
			return Ok(transformationRunWithTimestamps);
		},

		async addTransformationStep({
			run,
			step,
		}: {
			run: TransformationRun;
			step: {
				id: string;
				input: string;
			};
		}): Promise<Result<TransformationStepRun, DbServiceError>> {
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
				catch: (error) =>
					DbServiceErr({
						message: 'Error adding step run to transformation run in Dexie',
						context: { run, step },
						cause: error,
					}),
			});
			if (addStepRunToTransformationRunError)
				return Err(addStepRunToTransformationRunError);

			return Ok(newTransformationStepRun);
		},

		async failTransformationAtStepRun({
			run,
			stepRunId,
			error,
		}: {
			run: TransformationRun;
			stepRunId: string;
			error: string;
		}): Promise<Result<TransformationRunFailed, DbServiceError>> {
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
				catch: (error) =>
					DbServiceErr({
						message: 'Error updating transformation run as failed in Dexie',
						context: { run, stepId: stepRunId, error },
						cause: error,
					}),
			});
			if (updateTransformationStepRunError)
				return Err(updateTransformationStepRunError);

			return Ok(failedRun);
		},

		async completeTransformationStepRun({
			run,
			stepRunId,
			output,
		}: {
			run: TransformationRun;
			stepRunId: string;
			output: string;
		}): Promise<Result<TransformationRun, DbServiceError>> {
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
				catch: (error) =>
					DbServiceErr({
						message: 'Error updating transformation step run status in Dexie',
						context: { run, stepId: stepRunId, output },
						cause: error,
					}),
			});
			if (updateTransformationStepRunError)
				return Err(updateTransformationStepRunError);

			return Ok(updatedRun);
		},

		async completeTransformation({
			run,
			output,
		}: {
			run: TransformationRun;
			output: string;
		}): Promise<Result<TransformationRunCompleted, DbServiceError>> {
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
				catch: (error) =>
					DbServiceErr({
						message: 'Error updating transformation run as completed in Dexie',
						context: { run, output },
						cause: error,
					}),
			});
			if (updateTransformationStepRunError)
				return Err(updateTransformationStepRunError);

			return Ok(completedRun);
		},
		
		// Custom Sound Methods
		async saveCustomSound(customSound: CustomSound): Promise<Result<CustomSound, DbServiceError>> {
			return tryAsync({
				try: async () => {
					// console.log('🔧 DB: Attempting to save custom sound:', customSound);
					// console.log('🔧 DB: Database version:', db.verno);
					// console.log('🔧 DB: Database name:', db.name);
					// console.log('🔧 DB: Custom sounds table exists:', !!db.customSounds);
					// console.log('🔧 DB: All table names:', db.tables.map(t => t.name));
					
					// Check if the table schema is correct
					if (db.customSounds) {
						console.log('🔧 DB: Custom sounds table schema:', db.customSounds.schema);
					}
					
					// Validate the object has the required id field
					if (!customSound.id) {
						throw new Error('CustomSound object missing required id field');
					}
					
					console.log('🔧 DB: About to call put with object:', JSON.stringify({
						...customSound,
						serializedAudio: { ...customSound.serializedAudio, arrayBuffer: `[ArrayBuffer ${customSound.serializedAudio.arrayBuffer.byteLength} bytes]` }
					}, null, 2));
					
					await db.customSounds.put(customSound);
					console.log('🔧 DB: Custom sound saved successfully');
					return customSound;
				},
				mapErr: (error) => {
					console.error('🔧 DB: Failed to save custom sound:', error);
					return DbServiceErr({
						message: 'Failed to save custom sound',
						context: { soundId: customSound.id },
						cause: error,
					});
				},
			});
		},

		async getCustomSound(soundId: WhisperingSoundNames): Promise<Result<CustomSound | null, DbServiceError>> {
			return tryAsync({
				try: async () => {
					const customSound = await db.customSounds.get(soundId);
					return customSound ?? null;
				},
				mapErr: (error) => DbServiceErr({
					message: 'Failed to get custom sound',
					context: { soundId },
					cause: error,
				}),
			});
		},

		async getAllCustomSounds(): Promise<Result<CustomSound[], DbServiceError>> {
			return tryAsync({
				try: async () => {
					return await db.customSounds.toArray();
				},
				mapErr: (error) => DbServiceErr({
					message: 'Failed to get all custom sounds',
					cause: error,
				}),
			});
		},

		async deleteCustomSound(soundId: WhisperingSoundNames): Promise<Result<void, DbServiceError>> {
			return tryAsync({
				try: async () => {
					await db.customSounds.delete(soundId);
				},
				mapErr: (error) => DbServiceErr({
					message: 'Failed to delete custom sound',
					context: { soundId },
					cause: error,
				}),
			});
		},

		// Debug method to reset database
		async resetDatabase(): Promise<Result<void, DbServiceError>> {
			return tryAsync({
				try: async () => {
					console.log('🔧 DB: Resetting database...');
					await db.delete();
					console.log('🔧 DB: Database deleted, will recreate on next access');
					// The database will be recreated automatically on next access
				},
				mapErr: (error) =>
					DbServiceErr({
						message: 'Failed to reset database',
						context: {},
						cause: error,
					}),
			});
		},

		async getCustomSoundMetadata(soundId: WhisperingSoundNames): Promise<Result<import('./models/custom-sounds').CustomSoundMetadata | null, DbServiceError>> {
			return tryAsync({
				try: async () => {
					const customSound = await db.customSounds.get(soundId);
					if (!customSound) return null;
					
					return {
						fileName: customSound.fileName,
						fileSize: customSound.fileSize,
						blobType: customSound.serializedAudio.blobType,
						uploadedAt: customSound.uploadedAt,
					};
				},
				mapErr: (error) => DbServiceErr({
					message: 'Failed to get custom sound metadata',
					context: { soundId },
					cause: error,
				}),
			});
		},
	};
}

export type DbService = ReturnType<typeof createDbServiceDexie>;
