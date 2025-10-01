import OpenAI from 'openai';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { CompletionService } from './types';
import { CompletionServiceErr } from './types';

export function createOpenRouterCompletionService(): CompletionService {
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

      // Create OpenAI client configured for OpenRouter
      const client = new OpenAI({ 
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        dangerouslyAllowBrowser: true,
        defaultHeaders: {
          'HTTP-Referer': 'https://whispering.epicenter.so', // Optional, for analytics
          'X-Title': 'Whispering', // Optional, for analytics
        }
      });

      // Call OpenRouter API using OpenAI SDK
      const { data: completion, error: openRouterApiError } = await tryAsync({
        try: () =>
          client.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        catch: (error) => {
          // Check if it's NOT an OpenAI API error
          if (!(error instanceof OpenAI.APIError)) {
            // This is an unexpected error type
            throw error;
          }
          // Return the error directly
          return Err(error);
        },
      });

      if (openRouterApiError) {
        // Error handling follows OpenAI SDK error structure
        const { status, name, message, error } = openRouterApiError;

        // 400 - BadRequestError
        if (status === 400) {
          return CompletionServiceErr({
            message:
              message ??
              `Invalid request to OpenRouter API. ${error?.message ?? ''}`.trim(),
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 401 - AuthenticationError
        if (status === 401) {
          return CompletionServiceErr({
            message:
              message ??
              'Your OpenRouter API key appears to be invalid or expired. Please update your API key in settings.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 402 - Payment Required (OpenRouter specific)
        if (status === 402) {
          return CompletionServiceErr({
            message:
              message ??
              'Insufficient credits in your OpenRouter account. Please add credits to continue.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 403 - PermissionDeniedError
        if (status === 403) {
          return CompletionServiceErr({
            message:
              message ??
              "Your OpenRouter account doesn't have access to this model.",
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 404 - NotFoundError
        if (status === 404) {
          return CompletionServiceErr({
            message:
              message ??
              'The requested model was not found on OpenRouter. Please check the model name.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 422 - UnprocessableEntityError
        if (status === 422) {
          return CompletionServiceErr({
            message:
              message ??
              'The request was valid but OpenRouter cannot process it. Please check your parameters.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 429 - RateLimitError
        if (status === 429) {
          return CompletionServiceErr({
            message: message ?? 'OpenRouter rate limit exceeded. Please try again later.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 502 - Bad Gateway (OpenRouter specific - model provider issue)
        if (status === 502) {
          return CompletionServiceErr({
            message:
              message ??
              'The model provider is temporarily unavailable. OpenRouter will automatically retry with fallback models if configured.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // 503 - Service Unavailable
        if (status === 503) {
          return CompletionServiceErr({
            message:
              message ??
              'OpenRouter is temporarily unavailable. Please try again in a few minutes.',
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // >=500 - InternalServerError
        if (status && status >= 500) {
          return CompletionServiceErr({
            message:
              message ??
              `The OpenRouter service encountered an error (${status}). Please try again in a few minutes.`,
            context: { status, name },
            cause: openRouterApiError,
          });
        }

        // Handle APIConnectionError (no status code)
        if (!status && name === 'APIConnectionError') {
          return CompletionServiceErr({
            message:
              message ??
              'Unable to connect to the OpenRouter service. This could be a network issue or temporary service interruption.',
            context: { name },
            cause: openRouterApiError,
          });
        }

        // Catch-all for unexpected errors
        return CompletionServiceErr({
          message: message ?? 'An unexpected error occurred with OpenRouter. Please try again.',
          context: { status, name },
          cause: openRouterApiError,
        });
      }

      // Extract the response text
      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        return CompletionServiceErr({
          message: 'OpenRouter API returned an empty response',
          context: { model, completion },
          cause: undefined,
        });
      }

      return Ok(responseText);
    },
  };
}

export type OpenRouterCompletionService = ReturnType<
  typeof createOpenRouterCompletionService
>;

export const OpenRouterCompletionServiceLive = createOpenRouterCompletionService();