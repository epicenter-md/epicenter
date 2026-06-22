import Anthropic from '@anthropic-ai/sdk';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { customFetch } from '#platform/http';
import type { CompletionService } from './types';
import { CompletionError } from './types';

export const AnthropicCompletionServiceLive = {
	async complete({ apiKey, model, systemPrompt, userPrompt, signal }) {
		const client = new Anthropic({
			apiKey,
			dangerouslyAllowBrowser: true,
			fetch: customFetch,
		});
		// Call Anthropic API
		const { data: completion, error: anthropicApiError } = await tryAsync({
			try: () =>
				client.messages.create(
					{
						model,
						system: systemPrompt,
						messages: [{ role: 'user', content: userPrompt }],
						max_tokens: 1024,
					},
					{ signal },
				),
			catch: (error): Err<CompletionError> => {
				if (error instanceof Anthropic.APIConnectionError) {
					return CompletionError.ConnectionFailed({ cause: error });
				}
				if (!(error instanceof Anthropic.APIError)) throw error;
				return CompletionError.Http({ status: error.status, cause: error });
			},
		});

		if (anthropicApiError) return Err(anthropicApiError);

		// Extract the response text
		const responseText = completion.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('');

		if (!responseText) {
			return CompletionError.EmptyResponse({
				providerLabel: 'Anthropic',
			});
		}

		return Ok(responseText);
	},
} satisfies CompletionService;
