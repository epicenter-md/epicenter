import type { Transformation, TransformationStep } from '../workspace';
import { normalizeSpokenUrls } from './normalize-spoken-urls';
import { assertValidTransformationStep } from './transformation-validation';

export type RunnableTransformation = Transformation & {
	steps: TransformationStep[];
};

export type TransformationFailure = {
	transformationId: string;
	transformationName: string;
	stepId: string;
	stepPosition: number;
	message: string;
};

export type TransformationPipelineResult = {
	text: string;
	failures: TransformationFailure[];
};

/** Execute one Transformation atomically, regardless of its enabled state. */
export function executeTransformation(
	input: string,
	transformation: RunnableTransformation,
): { text: string; failure: TransformationFailure | null } {
	let text = input;
	for (const step of sortByPosition(transformation.steps)) {
		try {
			text = executeStep(text, step);
		} catch (cause) {
			return {
				text: input,
				failure: {
					transformationId: transformation.id,
					transformationName: transformation.name,
					stepId: step.id,
					stepPosition: step.position,
					message:
						cause instanceof Error
							? cause.message
							: 'Transformation step failed.',
				},
			};
		}
	}
	return { text, failure: null };
}

/** Run every enabled Transformation in stable order, preserving usable text. */
export function runTransformations(
	input: string,
	transformations: RunnableTransformation[],
): TransformationPipelineResult {
	let text = input;
	const failures: TransformationFailure[] = [];
	for (const transformation of sortByPosition(transformations)) {
		if (!transformation.enabled) continue;
		const result = executeTransformation(text, transformation);
		text = result.text;
		if (result.failure !== null) failures.push(result.failure);
	}
	return { text, failures };
}

function executeStep(input: string, step: TransformationStep): string {
	switch (step.kind) {
		case 'spoken_urls':
			return normalizeSpokenUrls(input);
		case 'find_replace': {
			assertValidTransformationStep(step);
			return step.useRegex
				? input.replace(new RegExp(step.find, 'g'), step.replace)
				: input.replaceAll(step.find, step.replace);
		}
		default:
			return step.kind satisfies never;
	}
}

function sortByPosition<TRow extends { id: string; position: number }>(
	rows: TRow[],
): TRow[] {
	return rows.toSorted(
		(left, right) =>
			left.position - right.position || left.id.localeCompare(right.id),
	);
}
