import { CompleteError } from '@epicenter/client';
import type { Result } from 'wellcrafted/result';
import type { CompletionState } from '$lib/operations/completion-target';

/** Epicenter V1 has no text-completion capability. */
export function resolveCompletionState(): CompletionState {
	return { target: null, canRun: false, textStaysOnDevice: true };
}

export function completeWithGlobalDefault(_input: {
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}): Promise<Result<string, CompleteError>> {
	return Promise.resolve(
		CompleteError.TransportFailed({
			cause: new Error('Epicenter V1 does not support text completion.'),
		}),
	);
}
