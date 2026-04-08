import { nanoid } from 'nanoid/non-secure';
import {
	generateDefaultTransformation,
	generateDefaultTransformationStep,
	type Recording,
	type Transformation,
} from '$lib/services/db';
import { createDbServiceWeb } from '$lib/services/db/web';
import { DownloadServiceLive } from '$lib/services/download';

export const MOCK_RECORDING_COUNT = 12;
export const MOCK_TRANSFORMATION_COUNT = 10;

function createMockRecording(index: number): {
	recording: Recording;
	audio: Blob;
} {
	const id = nanoid();
	const now = new Date().toISOString();
	const statuses = ['DONE', 'UNPROCESSED', 'FAILED', 'TRANSCRIBING'] as const;
	const transcriptionStatus = statuses[index % statuses.length] ?? 'DONE';

	const recording: Recording = {
		id,
		title: `Mock Recording ${index + 1}`,
		subtitle: 'Generated for workspace migration testing',
		timestamp: now,
		createdAt: now,
		updatedAt: now,
		transcribedText: index % 5 === 0 ? '' : `Mock transcript ${index + 1}`,
		transcriptionStatus,
	};

	const audio = new Blob([`mock-audio-${index}`], { type: 'audio/webm' });

	return { recording, audio };
}

/**
 * Step counts cycle: 0, 1, 3, 5 — tests empty, single, multi-step transformations.
 * Step types alternate between prompt_transform and find_replace.
 */
const STEP_COUNTS = [0, 1, 3, 5] as const;

function createMockTransformation(index: number): Transformation {
	const transformation = generateDefaultTransformation();
	transformation.title = `Mock Transformation ${index + 1}`;
	transformation.description = 'Generated for workspace migration testing';

	const stepCount = STEP_COUNTS[index % STEP_COUNTS.length] ?? 0;
	transformation.steps = Array.from({ length: stepCount }, (_, stepIndex) => {
		const step = generateDefaultTransformationStep();
		const isFindReplace = stepIndex % 2 === 1;
		if (isFindReplace) {
			step.type = 'find_replace';
			step['find_replace.findText'] = `find-${stepIndex}`;
			step['find_replace.replaceText'] = `replace-${stepIndex}`;
		} else {
			step['prompt_transform.systemPromptTemplate'] =
				`System prompt for step ${stepIndex}`;
			step['prompt_transform.userPromptTemplate'] = `Transform: {{input}}`;
		}
		return step;
	});

	return transformation;
}

export function createMigrationTestData() {
	const indexedDb = createDbServiceWeb({
		DownloadService: DownloadServiceLive,
	});

	return {
		async seedIndexedDB({
			recordingCount,
			transformationCount,
			onProgress,
		}: {
			recordingCount: number;
			transformationCount: number;
			onProgress: (message: string) => void;
		}): Promise<{ recordings: number; transformations: number }> {
			onProgress(
				`Seeding IndexedDB with ${recordingCount} recordings and ${transformationCount} transformations...`,
			);

			const recordings = Array.from({ length: recordingCount }, (_, index) =>
				createMockRecording(index),
			);

			const { error: recordingsError } =
				await indexedDb.recordings.create(recordings);
			if (recordingsError) {
				throw new Error(
					`Failed to seed recordings: ${recordingsError.message}`,
				);
			}

			const transformations = Array.from(
				{ length: transformationCount },
				(_, index) => createMockTransformation(index),
			);

			const { error: transformationsError } =
				await indexedDb.transformations.create(transformations);
			if (transformationsError) {
				throw new Error(
					`Failed to seed transformations: ${transformationsError.message}`,
				);
			}

			const totalSteps = transformations.reduce(
				(sum, t) => sum + t.steps.length,
				0,
			);
			onProgress(
				`✅ Seed complete: ${recordings.length} recordings, ${transformations.length} transformations (${totalSteps} steps)`,
			);

			return {
				recordings: recordings.length,
				transformations: transformations.length,
			};
		},

		async clearIndexedDB({
			onProgress,
		}: {
			onProgress: (message: string) => void;
		}): Promise<void> {
			onProgress('Clearing IndexedDB recordings, transformations, and runs...');

			const [recordingsResult, transformationsResult, runsResult] =
				await Promise.all([
					indexedDb.recordings.clear(),
					indexedDb.transformations.clear(),
					indexedDb.runs.clear(),
				]);

			if (recordingsResult.error) {
				throw new Error(
					`Failed to clear recordings: ${recordingsResult.error.message}`,
				);
			}

			if (transformationsResult.error) {
				throw new Error(
					`Failed to clear transformations: ${transformationsResult.error.message}`,
				);
			}

			if (runsResult.error) {
				throw new Error(`Failed to clear runs: ${runsResult.error.message}`);
			}

			onProgress('✅ IndexedDB cleared');
		},
	};
}
