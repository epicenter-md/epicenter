import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Settings } from '$lib/settings';
import type {
	Recording,
	Transformation,
	TransformationRun,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationStepRun,
} from './models';

export const { DbServiceError, DbServiceErr } =
	createTaggedError('DbServiceError');
export type DbServiceError = ReturnType<typeof DbServiceError>;

export type DbService = {
	recordings: {
		getAll(): Promise<Result<Recording[], DbServiceError>>;
		getLatest(): Promise<Result<Recording | null, DbServiceError>>;
		getTranscribingIds(): Promise<Result<string[], DbServiceError>>;
		getById(id: string): Promise<Result<Recording | null, DbServiceError>>;
		create(
			params:
				| { recording: Recording; audio: Blob }
				| Array<{ recording: Recording; audio: Blob }>,
		): Promise<Result<void, DbServiceError>>;
		update(recording: Recording): Promise<Result<Recording, DbServiceError>>;
		delete(
			recordings: Recording | Recording[],
		): Promise<Result<void, DbServiceError>>;
		cleanupExpired(params: {
			recordingRetentionStrategy: Settings['database.recordingRetentionStrategy'];
			maxRecordingCount: Settings['database.maxRecordingCount'];
		}): Promise<Result<void, DbServiceError>>;
		clear(): Promise<Result<void, DbServiceError>>;
		getCount(): Promise<Result<number, DbServiceError>>;

		/**
		 * Get audio blob by recording ID. Fetches audio on-demand.
		 * - Desktop: Reads file from predictable path using services.fs.pathToBlob()
		 * - Web: Fetches from IndexedDB by ID, converts serializedAudio to Blob
		 */
		getAudioBlob(recordingId: string): Promise<Result<Blob, DbServiceError>>;

		/**
		 * Get audio playback URL. Creates and caches URL.
		 * - Desktop: Uses convertFileSrc() to create asset:// URL
		 * - Web: Creates and caches object URL, manages lifecycle
		 */
		ensureAudioPlaybackUrl(
			recordingId: string,
		): Promise<Result<string, DbServiceError>>;

		/**
		 * Revoke audio URL if cached. Cleanup method.
		 * - Desktop: No-op (asset:// URLs managed by Tauri)
		 * - Web: Calls URL.revokeObjectURL() and removes from cache
		 */
		revokeAudioUrl(recordingId: string): void;
	};
	transformations: {
		getAll(): Promise<Result<Transformation[], DbServiceError>>;
		getById(id: string): Promise<Result<Transformation | null, DbServiceError>>;
		create(
			transformation: Transformation | Transformation[],
		): Promise<Result<Transformation | Transformation[], DbServiceError>>;
		update(
			transformation: Transformation,
		): Promise<Result<Transformation, DbServiceError>>;
		delete(
			transformations: Transformation | Transformation[],
		): Promise<Result<void, DbServiceError>>;
		clear(): Promise<Result<void, DbServiceError>>;
		getCount(): Promise<Result<number, DbServiceError>>;
	};
	runs: {
		getAll(): Promise<Result<TransformationRun[], DbServiceError>>;
		getById(
			id: string,
		): Promise<Result<TransformationRun | null, DbServiceError>>;
		getByTransformationId(
			transformationId: string,
		): Promise<Result<TransformationRun[], DbServiceError>>;
		getByRecordingId(
			recordingId: string,
		): Promise<Result<TransformationRun[], DbServiceError>>;
		create(
			params:
				| {
						transformationId: string;
						recordingId: string | null;
						input: string;
				  }
				| Array<{
						run: TransformationRun;
				  }>,
		): Promise<Result<TransformationRun | TransformationRun[], DbServiceError>>;
		addStep(
			run: TransformationRun,
			step: {
				id: string;
				input: string;
			},
		): Promise<Result<TransformationStepRun, DbServiceError>>;
		failStep(
			run: TransformationRun,
			stepRunId: string,
			error: string,
		): Promise<Result<TransformationRunFailed, DbServiceError>>;
		completeStep(
			run: TransformationRun,
			stepRunId: string,
			output: string,
		): Promise<Result<TransformationRun, DbServiceError>>;
		complete(
			run: TransformationRun,
			output: string,
		): Promise<Result<TransformationRunCompleted, DbServiceError>>;
		delete(
			runs: TransformationRun | TransformationRun[],
		): Promise<Result<void, DbServiceError>>;
		clear(): Promise<Result<void, DbServiceError>>;
		getCount(): Promise<Result<number, DbServiceError>>;
	};
};
