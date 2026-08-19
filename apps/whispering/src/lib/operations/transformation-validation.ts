import type { TransformationStep } from '../workspace';

/** Validate the step invariants the portable table declaration cannot express. */
export function getTransformationStepError(
	step: Pick<TransformationStep, 'kind' | 'find' | 'useRegex'>,
): string | null {
	if (step.kind === 'spoken_urls') return null;
	if (step.find.trim().length === 0) {
		return 'Find and replace steps require non-blank find text.';
	}
	if (!step.useRegex) return null;
	try {
		new RegExp(step.find, 'g');
		return null;
	} catch (cause) {
		return `Invalid regular expression: ${cause instanceof Error ? cause.message : step.find}`;
	}
}

/** Throw at write and execution boundaries while UI callers render the message. */
export function assertValidTransformationStep(
	step: Pick<TransformationStep, 'kind' | 'find' | 'useRegex'>,
): void {
	const message = getTransformationStepError(step);
	if (message !== null) throw new Error(message);
}
