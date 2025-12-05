import { Ok } from 'wellcrafted/result';
import { createOpenAiCompatibleCompletionService } from './openai-compatible';
import { CompletionServiceErr } from './types';

/**
 * Custom completion service for local LLM endpoints (Ollama, LM Studio, llama.cpp, etc.)
 * Uses the OpenAI-compatible API pattern that most local servers support.
 */
export const CustomCompletionServiceLive = createOpenAiCompatibleCompletionService({
	providerLabel: 'Custom',
	getBaseUrl: (params) => params.baseUrl,
	validateParams: (params) => {
		if (!params.baseUrl) {
			return CompletionServiceErr({
				message: 'Custom provider requires a base URL.',
				context: { status: 400, name: 'MissingBaseUrl' },
				cause: null,
			});
		}
		if (!params.model) {
			return CompletionServiceErr({
				message: 'Custom provider requires a model name.',
				context: { status: 400, name: 'MissingModel' },
				cause: null,
			});
		}
		return Ok(undefined);
	},
});

export type CustomCompletionService = typeof CustomCompletionServiceLive;
