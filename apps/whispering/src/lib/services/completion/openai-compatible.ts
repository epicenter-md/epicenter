import OpenAI from 'openai';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionServiceErr } from './types';

export type OpenAiCompatibleConfig = {
	providerLabel: string;
	baseUrl?: string;
	defaultHeaders?: Record<string, string>;
	statusMessageOverrides?: Partial<Record<number, string>>;
};

export function createOpenAiCompatibleCompletionService(
	config: OpenAiCompatibleConfig,
): CompletionService {
	return {
		async complete({ apiKey, model, baseUrl, systemPrompt, userPrompt }) {
			const client = new OpenAI({
				apiKey,
				baseURL: (config.baseUrl ?? baseUrl) || undefined,
				dangerouslyAllowBrowser: true,
				defaultHeaders: config.defaultHeaders,
			});

			const { data: completion, error: apiError } = await tryAsync({
				try: () =>
					client.chat.completions.create({
						model,
						messages: [
							{ role: 'system', content: systemPrompt },
							{ role: 'user', content: userPrompt },
						],
					}),
				catch: (error) => {
					if (!(error instanceof OpenAI.APIError)) {
						throw error;
					}
					return Err(error);
				},
			});

			if (apiError) {
				const { status, name, message, error } = apiError;

				if (typeof status === 'number') {
					const override = config.statusMessageOverrides?.[status];
					if (override) {
						return CompletionServiceErr({
							message: override,
							context: { status, name },
							cause: apiError,
						});
					}
				}

				if (status === 400) {
					return CompletionServiceErr({
						message:
							message ??
							`Invalid request to ${config.providerLabel} API. ${error?.message ?? ''}`.trim(),
						context: { status, name },
						cause: apiError,
					});
				}

				if (status === 401) {
					return CompletionServiceErr({
						message:
							message ??
							`Your ${config.providerLabel} API key appears to be invalid or expired. Please update your API key in settings.`,
						context: { status, name },
						cause: apiError,
					});
				}

				if (status === 403) {
					return CompletionServiceErr({
						message:
							message ??
							`Your ${config.providerLabel} account doesn't have access to this model or feature.`,
						context: { status, name },
						cause: apiError,
					});
				}

				if (status === 404) {
					return CompletionServiceErr({
						message:
							message ??
							`The requested model was not found on ${config.providerLabel}. Please check the model name.`,
						context: { status, name },
						cause: apiError,
					});
				}

				if (status === 422) {
					return CompletionServiceErr({
						message:
							message ??
							`The request was valid but ${config.providerLabel} cannot process it. Please check your parameters.`,
						context: { status, name },
						cause: apiError,
					});
				}

				if (status === 429) {
					return CompletionServiceErr({
						message:
							message ??
							`${config.providerLabel} rate limit exceeded. Please try again later.`,
						context: { status, name },
						cause: apiError,
					});
				}

				if (status && status >= 500) {
					return CompletionServiceErr({
						message:
							message ??
							`The ${config.providerLabel} service is temporarily unavailable (Error ${status}). Please try again in a few minutes.`,
						context: { status, name },
						cause: apiError,
					});
				}

				if (!status && name === 'APIConnectionError') {
					return CompletionServiceErr({
						message:
							message ??
							`Unable to connect to the ${config.providerLabel} service. This could be a network issue or temporary service interruption.`,
						context: { name },
						cause: apiError,
					});
				}

				return CompletionServiceErr({
					message:
						message ?? `An unexpected error occurred with ${config.providerLabel}. Please try again.`,
					context: { status, name },
					cause: apiError,
				});
			}

			const responseText = completion.choices.at(0)?.message?.content;
			if (!responseText) {
				return CompletionServiceErr({
					message: `${config.providerLabel} API returned an empty response`,
					context: { model, completion },
					cause: undefined,
				});
			}

			return Ok(responseText);
		},
	};
}
