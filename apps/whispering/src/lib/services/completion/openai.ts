import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import type { CompletionService } from './types';

export function createOpenAiCompletionService(): CompletionService {
	return createOpenAiCompatibleCompletionService({
		providerLabel: 'OpenAI',
	});
}

export type OpenaiCompletionService = ReturnType<
	typeof createOpenAiCompletionService
>;

export const OpenaiCompletionServiceLive = createOpenAiCompletionService();
