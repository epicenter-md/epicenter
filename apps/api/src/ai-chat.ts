import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	type Tool,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { ANTHROPIC_MODELS, createAnthropicChat } from '@tanstack/ai-anthropic';
import { createOpenaiChat, OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { createFactory } from 'hono/factory';
import { defineErrors } from 'wellcrafted/error';
import type { Env } from './app';

const chatOptions = type({
	'systemPrompts?': 'string[] | undefined',
	'temperature?': 'number | undefined',
	'maxTokens?': 'number | undefined',
	'topP?': 'number | undefined',
	'metadata?': 'Record<string, unknown> | undefined',
	'conversationId?': 'string | undefined',
	'tools?': 'object[] | undefined',
});

const AiChatError = defineErrors({
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		provider,
	}),
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: chatOptions.merge(
		type.or(
			{ provider: "'openai'", model: type.enumerated(...OPENAI_CHAT_MODELS) },
			{ provider: "'anthropic'", model: type.enumerated(...ANTHROPIC_MODELS) },
		),
	),
});

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data } = c.req.valid('json');
		const { provider, tools, ...options } = data;

		let adapter: AnyTextAdapter;
		switch (data.provider) {
			case 'openai': {
				const apiKey = c.env.OPENAI_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createOpenaiChat(data.model, apiKey);
				break;
			}
			case 'anthropic': {
				const apiKey = c.env.ANTHROPIC_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createAnthropicChat(data.model, apiKey);
				break;
			}
		}

		const abortController = new AbortController();
		const stream = chat({
			adapter,
			messages: messages as Array<ModelMessage>,
			...options,
			tools: tools as Array<Tool> | undefined,
			abortController,
		});

		return toServerSentEventsResponse(stream, { abortController });
	},
);
