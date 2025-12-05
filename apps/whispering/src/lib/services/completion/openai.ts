import { createOpenAiCompatibleCompletionService } from './openai-compatible';

export const OpenaiCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'OpenAI',
		getBaseUrl: () => undefined, // Use OpenAI SDK default
	});

export type OpenaiCompletionService = typeof OpenaiCompletionServiceLive;
