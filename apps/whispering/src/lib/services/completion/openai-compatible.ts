import OpenAI from 'openai';
import { Err, isErr, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionServiceErr, type CompletionServiceError } from './types';

export type OpenAiCompatibleConfig = {
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
	 * CompletionServiceError if validation fails.
	 *
	 * @example
	 * ```typescript
	 * validateParams: (params) => {
	 *   if (!params.baseUrl) {
	 *     return CompletionServiceErr({
	 *       message: 'Base URL is required',
	 *       context: { status: 400, name: 'MissingBaseUrl' },
	 *       cause: null,
	 *     });
	 *   }
	 *   return Ok(undefined);
	 * }
	 * ```
	 */
	validateParams?: (
		params: Parameters<CompletionService['complete']>[0],
	) => Result<void, CompletionServiceError>;

	/**
	 * HTTP headers to include with every request.
	 *
	 * Useful for provider-specific requirements like referrer headers,
	 * API versioning, or custom authentication schemes.
	 *
	 * @example { 'HTTP-Referer': 'https://myapp.com', 'X-Title': 'MyApp' }
	 */
	defaultHeaders?: Record<string, string>;

	/**
	 * Custom error messages for specific HTTP status codes.
	 *
	 * Allows providers to override default error messages with
	 * provider-specific guidance (e.g., billing issues, service-specific errors).
	 *
	 * @example { 402: 'Insufficient credits. Please add credits to continue.' }
	 */
	statusMessageOverrides?: Partial<Record<number, string>>;
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
 * // Provider with custom headers and error messages
 * const openrouter = createOpenAiCompatibleCompletionService({
 *   providerLabel: 'OpenRouter',
 *   defaultHeaders: {
 *     'HTTP-Referer': 'https://whispering.epicenter.so',
 *     'X-Title': 'Whispering',
 *   },
 *   statusMessageOverrides: {
 *     402: 'Insufficient credits in your OpenRouter account.',
 *   },
 * });
 * ```
 */
export function createOpenAiCompatibleCompletionService(
	config: OpenAiCompatibleConfig,
): CompletionService {
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
			});

			const { data: completion, error: apiError } = await tryAsync({
				try: () =>
					client.chat.completions.create({
						model: params.model,
						messages: [
							{ role: 'system', content: params.systemPrompt },
							{ role: 'user', content: params.userPrompt },
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
						message ??
						`An unexpected error occurred with ${config.providerLabel}. Please try again.`,
					context: { status, name },
					cause: apiError,
				});
			}

			const responseText = completion.choices.at(0)?.message?.content;
			if (!responseText) {
				return CompletionServiceErr({
					message: `${config.providerLabel} API returned an empty response`,
					context: { model: params.model, completion },
					cause: undefined,
				});
			}

			return Ok(responseText);
		},
	};
}
