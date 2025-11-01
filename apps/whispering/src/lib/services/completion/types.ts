import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const { CompletionServiceError, CompletionServiceErr } =
	createTaggedError('CompletionServiceError');
export type CompletionServiceError = ReturnType<typeof CompletionServiceError>;

export type CompletionService = {
	complete: (opts: {
		apiKey: string;
		model: string;
		systemPrompt: string;
		userPrompt: string;
		baseURL?: string; // Optional base URL for custom endpoints
	}) => Promise<Result<string, CompletionServiceError>>;
};
