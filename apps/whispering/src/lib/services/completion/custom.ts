import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import type { CompletionService } from './types';
import { CompletionServiceErr } from './types';

export function createCustomCompletionService(): CompletionService {
	const service = createOpenAiCompatibleCompletionService({
		providerLabel: 'Custom',
	});

	return {
		async complete({ apiKey, model, baseUrl, systemPrompt, userPrompt }) {
			if (!baseUrl) {
				return CompletionServiceErr({
					message: 'Custom provider requires a base URL.',
					context: { status: 400, name: 'MissingBaseUrl' },
					cause: null,
				});
			}
			if (!model) {
				return CompletionServiceErr({
					message: 'Custom provider requires a model name.',
					context: { status: 400, name: 'MissingModel' },
					cause: null,
				});
			}

			return service.complete({
				apiKey,
				model,
				baseUrl,
				systemPrompt,
				userPrompt,
			});
		},
	};
}

export type CustomCompletionService = ReturnType<
	typeof createCustomCompletionService
>;

export const CustomCompletionServiceLive = createCustomCompletionService();
