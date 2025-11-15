import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import type { CompletionService } from './types';
import { CompletionServiceErr } from './types';

export function createOpenRouterCompletionService(): CompletionService {
	const service = createOpenAiCompatibleCompletionService({
		providerLabel: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		defaultHeaders: {
			'HTTP-Referer': 'https://whispering.epicenter.so',
			'X-Title': 'Whispering',
		},
		statusMessageOverrides: {
			402: 'Insufficient credits in your OpenRouter account. Please add credits to continue.',
			502: 'The model provider is temporarily unavailable. OpenRouter will automatically retry with fallback models if configured.',
			503: 'OpenRouter is temporarily unavailable. Please try again in a few minutes.',
		},
	});

	return {
		async complete({ apiKey, model, systemPrompt, userPrompt }) {
			if (!apiKey) {
				return CompletionServiceErr({
					message: 'OpenRouter API key is required.',
					context: { status: 401, name: 'MissingApiKey' },
					cause: null,
				});
			}
			if (!model) {
				return CompletionServiceErr({
					message: 'Model name is required for OpenRouter completion.',
					context: { status: 400, name: 'MissingModel' },
					cause: null,
				});
			}

			return service.complete({
				apiKey,
				model,
				systemPrompt,
				userPrompt,
			});
		},
	};
}

export type OpenRouterCompletionService = ReturnType<
	typeof createOpenRouterCompletionService
>;

export const OpenRouterCompletionServiceLive =
	createOpenRouterCompletionService();
