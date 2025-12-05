import { createOpenAiCompatibleCompletionService } from './openai-compatible';

export const OpenRouterCompletionServiceLive =
	createOpenAiCompatibleCompletionService({
		providerLabel: 'OpenRouter',
		getBaseUrl: () => 'https://openrouter.ai/api/v1', // Always use OpenRouter endpoint
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

export type OpenRouterCompletionService =
	typeof OpenRouterCompletionServiceLive;
