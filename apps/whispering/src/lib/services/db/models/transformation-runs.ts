import { type } from 'arktype';

/**
 * Base fields shared by all transformation step run variants.
 */
const BaseTransformationStepRun = {
	id: 'string',
	stepId: 'string',
	startedAt: 'string',
	completedAt: 'string | null',
	input: 'string',
} as const;

export const TransformationStepRunRunning = type({
	...BaseTransformationStepRun,
	status: '"running"',
});

export type TransformationStepRunRunning =
	typeof TransformationStepRunRunning.infer;

export const TransformationStepRunCompleted = type({
	...BaseTransformationStepRun,
	status: '"completed"',
	output: 'string',
});

export type TransformationStepRunCompleted =
	typeof TransformationStepRunCompleted.infer;

export const TransformationStepRunFailed = type({
	...BaseTransformationStepRun,
	status: '"failed"',
	error: 'string',
});

export type TransformationStepRunFailed =
	typeof TransformationStepRunFailed.infer;

export const TransformationStepRun = TransformationStepRunRunning.or(
	TransformationStepRunCompleted,
).or(TransformationStepRunFailed);

export type TransformationStepRun = typeof TransformationStepRun.infer;

/**
 * Base properties shared by all transformation run variants.
 *
 * Status transitions:
 * 1. 'running' - Initial state when created and transformation is immediately invoked
 * 2. 'completed' - When all steps have completed successfully
 * 3. 'failed' - If any step fails or an error occurs
 */
const BaseTransformationRun = {
	id: 'string',
	transformationId: 'string',
	/**
	 * Recording id if the transformation is invoked on a recording.
	 * Null if the transformation is invoked on arbitrary text input.
	 */
	recordingId: 'string | null',
	startedAt: 'string',
	completedAt: 'string | null',
	/**
	 * Because the recording's transcribedText can change after invoking,
	 * we store a snapshot of the transcribedText at the time of invoking.
	 */
	input: 'string',
	stepRuns: [TransformationStepRun, '[]'],
} as const;

export const TransformationRunRunning = type({
	...BaseTransformationRun,
	status: '"running"',
});

export type TransformationRunRunning = typeof TransformationRunRunning.infer;

export const TransformationRunCompleted = type({
	...BaseTransformationRun,
	status: '"completed"',
	output: 'string',
});

export type TransformationRunCompleted =
	typeof TransformationRunCompleted.infer;

export const TransformationRunFailed = type({
	...BaseTransformationRun,
	status: '"failed"',
	error: 'string',
});

export type TransformationRunFailed = typeof TransformationRunFailed.infer;

/**
 * Represents an execution of a transformation, which can be run on either
 * a recording's transcribed text or arbitrary input text.
 */
export const TransformationRun = TransformationRunRunning.or(
	TransformationRunCompleted,
).or(TransformationRunFailed);

export type TransformationRun = typeof TransformationRun.infer;
