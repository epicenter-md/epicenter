import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	type Tool,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { ANTHROPIC_MODELS, createAnthropicChat } from '@tanstack/ai-anthropic';
import { createGeminiChat, GeminiTextModels } from '@tanstack/ai-gemini';
import { createGrokText, GROK_CHAT_MODELS } from '@tanstack/ai-grok';
import { createOpenaiChat, OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { createFactory } from 'hono/factory';
import { defineErrors } from 'wellcrafted/error';
import { FEATURE_IDS } from './billing-plans';
import type { Env } from './app';
import { createAutumn } from './autumn';
import { MODEL_CREDITS } from './model-costs';

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
	UnknownModel: ({ model }: { model: string }) => ({
		message: `Unknown model: ${model}`,
		model,
	}),
	InsufficientCredits: ({ balance }: { balance: unknown }) => ({
		message: 'Insufficient credits',
		balance,
	}),
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: chatOptions.merge(
		type.or(
			{ provider: "'openai'", model: type.enumerated(...OPENAI_CHAT_MODELS) },
			{ provider: "'anthropic'", model: type.enumerated(...ANTHROPIC_MODELS) },
			{ provider: "'gemini'", model: type.enumerated(...GeminiTextModels) },
			{ provider: "'grok'", model: type.enumerated(...GROK_CHAT_MODELS) },
		),
	),
});

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data } = c.req.valid('json');
		const { provider, tools, ...options } = data;

		// ---------------------------------------------------------------
		// Credit check
		// ---------------------------------------------------------------
		const credits = MODEL_CREDITS[data.model];
		if (credits === undefined) {
			return c.json(AiChatError.UnknownModel({ model: data.model }), 400);
		}

		const autumn = createAutumn(c.env);
		const { allowed, balance } = await autumn.check({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.aiUsage,
			requiredBalance: credits,
			sendEvent: true,
			withPreview: true,
			properties: { model: data.model, provider: data.provider },
		});

		if (!allowed) {
			return c.json(AiChatError.InsufficientCredits({ balance }), 402);
		}

		// ---------------------------------------------------------------
		// Adapter + stream
		// ---------------------------------------------------------------
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
			case 'gemini': {
				const apiKey = c.env.GEMINI_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createGeminiChat(data.model, apiKey);
				break;
			}
			case 'grok': {
				const apiKey = c.env.GROK_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createGrokText(data.model, apiKey);
				break;
			}
		}

		try {
			const abortController = new AbortController();
			const stream = chat({
				adapter,
				messages: messages as Array<ModelMessage>,
				...options,
				tools: tools as Array<Tool> | undefined,
				abortController,
			});

			return toServerSentEventsResponse(stream, { abortController });
		} catch (error) {
			// Refund the credit that was atomically deducted by sendEvent: true
			c.var.afterResponse.push(
				autumn.track({
					customerId: c.var.user.id,
					featureId: FEATURE_IDS.aiUsage,
					value: -credits,
				}),
			);
			throw error;
		}
	},
);
