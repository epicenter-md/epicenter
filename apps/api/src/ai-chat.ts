import { AiChatError } from '@epicenter/constants/ai-chat-errors';
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
import { createOpenaiChat, OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { createFactory } from 'hono/factory';
import type { Env } from './app';
import { createAutumn } from './autumn';
import { FEATURE_IDS, PLAN_IDS } from './billing-plans';
import { MODEL_CREDITS } from './model-costs';

/**
 * Maximum credit cost a Free tier user can spend per request.
 * Models costing more than this are rejected for Free users.
 * This effectively restricts Free to mini/flash/haiku models (1-2 credits).
 */
const FREE_TIER_MAX_CREDITS = 2;

const chatOptions = type({
	'systemPrompts?': 'string[] | undefined',
	'temperature?': 'number | undefined',
	'maxTokens?': 'number | undefined',
	'topP?': 'number | undefined',
	'metadata?': 'Record<string, unknown> | undefined',
	'conversationId?': 'string | undefined',
	'tools?': 'object[] | undefined',
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: chatOptions.merge(
		type.or(
			{ provider: "'openai'", model: type.enumerated(...OPENAI_CHAT_MODELS) },
			{ provider: "'anthropic'", model: type.enumerated(...ANTHROPIC_MODELS) },
			{ provider: "'gemini'", model: type.enumerated(...GeminiTextModels) },
		),
	),
	/** User-provided API key for BYOK. When present, billing is bypassed entirely. */
	'apiKey?': 'string | undefined',
});

const factory = createFactory<Env>();

export const aiChatHandlers = factory.createHandlers(
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data, apiKey: userApiKey } = c.req.valid('json');
		const { provider, tools, ...options } = data;
		const isByok = !!userApiKey;

		// ---------------------------------------------------------------
		// Model lookup (needed for both billing and BYOK paths)
		// ---------------------------------------------------------------
		const credits = MODEL_CREDITS[data.model];
		if (credits === undefined) {
			return c.json(AiChatError.UnknownModel({ model: data.model }), 400);
		}

		// ---------------------------------------------------------------
		// BYOK: user-provided key bypasses all billing
		// ---------------------------------------------------------------
		let autumn: ReturnType<typeof createAutumn> | undefined;

		if (!isByok) {
			// Free tier model gating: reject expensive models
			if (c.var.planId === PLAN_IDS.free && credits > FREE_TIER_MAX_CREDITS) {
				return c.json(
					AiChatError.ModelRequiresPaidPlan({ model: data.model, credits }),
					403,
				);
			}

			// Credit check + atomic deduction
			autumn = createAutumn(c.env);
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
		}

		// ---------------------------------------------------------------
		// Adapter + stream
		// ---------------------------------------------------------------
		let adapter: AnyTextAdapter;
		switch (data.provider) {
			case 'openai': {
				const apiKey = userApiKey ?? c.env.OPENAI_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createOpenaiChat(data.model, apiKey);
				break;
			}
			case 'anthropic': {
				const apiKey = userApiKey ?? c.env.ANTHROPIC_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createAnthropicChat(data.model, apiKey);
				break;
			}
			case 'gemini': {
				const apiKey = userApiKey ?? c.env.GEMINI_API_KEY;
				if (!apiKey)
					return c.json(AiChatError.ProviderNotConfigured({ provider }), 503);
				adapter = createGeminiChat(data.model, apiKey);
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
			// Only refund if we actually deducted (not BYOK)
			if (autumn) {
				c.var.afterResponse.push(
					autumn.track({
						customerId: c.var.user.id,
						featureId: FEATURE_IDS.aiUsage,
						value: -credits,
					}),
				);
			}
			throw error;
		}
	},
);
