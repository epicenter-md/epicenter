import OpenAI from 'openai';
import { Err, isErr, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { customFetch } from '#platform/http';
import type { CompletionService } from './types';
import { CompletionError } from './types';

type OpenAiCompatibleConfig = {
	/**
	 * Human-readable provider name used in error messages.
	 *
	 * @example 'OpenAI', 'OpenRouter', 'Custom'
	 */
	providerLabel: string;

	/**
	 * Function to determine the baseUrl for each API call.
	 *
	 * This allows each provider to control its endpoint strategy:
	 * - Return undefined to use OpenAI SDK default (https://api.openai.com/v1)
	 * - Return a static string for fixed endpoints (e.g., OpenRouter)
	 * - Extract from params for dynamic endpoints (e.g., Custom provider)
	 *
	 * @example () => undefined  // OpenAI: use SDK default
	 * @example () => 'https://openrouter.ai/api/v1'  // OpenRouter: static URL
	 * @example (params) => params.baseUrl  // Custom: dynamic from params
	 */
	getBaseUrl: (
		params: Parameters<CompletionService['complete']>[0],
	) => string | undefined;

	/**
	 * Optional validation function called before making the API request.
	 *
	 * Use this to validate required parameters specific to your provider.
	 * Return Ok(undefined) if validation passes, or an Err with a
	 * CompletionError if validation fails.
	 *
	 * @example
	 * ```typescript
	 * validateParams: (params) => {
	 *   if (!params.baseUrl) {
	 *     return CompletionError.MissingParam({ param: 'Base URL' });
	 *   }
	 *   return Ok(undefined);
	 * }
	 * ```
	 */
	validateParams?: (
		params: Parameters<CompletionService['complete']>[0],
	) => Result<void, CompletionError>;

	/**
	 * HTTP headers to include with every request.
	 *
	 * Useful for provider-specific requirements like referrer headers,
	 * API versioning, or custom authentication schemes.
	 *
	 * @example { 'HTTP-Referer': 'https://myapp.com', 'X-Title': 'MyApp' }
	 */
	defaultHeaders?: Record<string, string>;
};

/**
 * Creates a completion service that works with any OpenAI-compatible API.
 *
 * This factory function provides a reusable implementation for providers that
 * implement the OpenAI Chat Completions API format. It handles error mapping,
 * connection errors, and response validation.
 *
 * The baseUrl is provided at runtime via the complete() method, allowing each
 * provider to determine its endpoint strategy:
 * - OpenAI: omit baseUrl to use the OpenAI SDK default (https://api.openai.com/v1)
 * - OpenRouter: always pass 'https://openrouter.ai/api/v1'
 * - Custom: pass dynamic baseUrl from user settings/step configuration
 *
 * @param config - Configuration for provider-specific behavior
 * @returns A CompletionService that can be used to generate text completions
 *
 * @example
 * ```typescript
 * // Simple provider (OpenAI uses SDK default)
 * const openai = createOpenAiCompatibleCompletionService({
 *   providerLabel: 'OpenAI',
 * });
 *
 * // Provider with custom headers
 * const openrouter = createOpenAiCompatibleCompletionService({
 *   providerLabel: 'OpenRouter',
 *   defaultHeaders: {
 *     'HTTP-Referer': 'https://whispering.epicenter.so',
 *     'X-Title': 'Whispering',
 *   },
 * });
 * ```
 */
export function createOpenAiCompatibleCompletionService(
	config: OpenAiCompatibleConfig,
) {
	return {
		async complete(params) {
			// Validate params if validator provided
			if (config.validateParams) {
				const validationResult = config.validateParams(params);
				if (isErr(validationResult)) {
					return validationResult;
				}
			}

			// Determine baseUrl using config function
			const effectiveBaseUrl = config.getBaseUrl(params);

			const client = new OpenAI({
				apiKey: params.apiKey,
				baseURL: effectiveBaseUrl,
				dangerouslyAllowBrowser: true,
				defaultHeaders: config.defaultHeaders,
				fetch: customFetch,
			});

			const { data: completion, error: apiError } = await tryAsync({
				try: () =>
					client.chat.completions.create(
						{
							model: params.model,
							messages: [
								{ role: 'system', content: params.systemPrompt },
								{ role: 'user', content: params.userPrompt },
							],
						},
						{ signal: params.signal },
					),
				catch: (error): Err<CompletionError> => {
					if (error instanceof OpenAI.APIConnectionError) {
						return CompletionError.ConnectionFailed({ cause: error });
					}
					if (!(error instanceof OpenAI.APIError)) throw error;
					return CompletionError.Http({
						status: error.status,
						cause: error,
					});
				},
			});

			if (apiError) return Err(apiError);

			const responseText = completion.choices.at(0)?.message?.content;
			if (!responseText) {
				return CompletionError.EmptyResponse({
					providerLabel: config.providerLabel,
				});
			}

			return Ok(responseText);
		},
	} satisfies CompletionService;
}
