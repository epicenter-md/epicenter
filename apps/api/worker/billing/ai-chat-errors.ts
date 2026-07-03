import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the metered inference path.
 *
 * Owned by the cloud billing layer that emits them: the metering policy calls
 * the factories at runtime (`AiChatError.InsufficientCredits(...)`) and renders
 * them into the OpenAI error envelope (`{ error: { message, code } }`), with the
 * variant `name` as `error.code`. The library gateway
 * (`@epicenter/server` inference route) stays billing-agnostic and emits its own
 * OpenAI-shaped errors, so this union is hosted-only, not a shared contract.
 *
 * Each variant's `name` field is the discriminant: use `switch (error.name)`
 * for exhaustive handling with full TypeScript narrowing.
 *
 * HTTP status codes live in the sibling `AiChatErrorStatus` map below, not
 * on the factory or in the wire body. The map is `satisfies`-checked
 * against the variant union, so adding a variant without picking a status
 * is a compile error.
 *
 * @example
 * ```ts
 * import { AiChatError, AiChatErrorStatus } from './ai-chat-errors.js';
 * return c.json(
 *   AiChatError.InsufficientCredits({ balance: 42 }),
 *   AiChatErrorStatus.InsufficientCredits,
 * ); // 402
 * ```
 */
export const AiChatError = defineErrors({
	Unauthorized: () => ({ message: 'Unauthorized' }),
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
	ModelRequiresPaidPlan: ({
		model,
		credits,
	}: {
		model: string;
		credits: number;
	}) => ({
		message: `${model} requires a paid plan (costs ${credits} credits)`,
		model,
		credits,
	}),
});

/**
 * Discriminated union of all AI chat error payloads.
 *
 * Reused by both server (runtime) and client (type narrowing).
 * The `name` field discriminates variants in `switch` statements.
 *
 * @example
 * ```ts
 * function handleError(error: AiChatError) {
 *   switch (error.name) {
 *     case 'InsufficientCredits':
 *       console.log(error.balance); // TypeScript knows this exists
 *       break;
 *     case 'ModelRequiresPaidPlan':
 *       console.log(error.model, error.credits); // narrowed
 *       break;
 *   }
 * }
 * ```
 */
export type AiChatError = InferErrors<typeof AiChatError>;

/**
 * HTTP status code for each `AiChatError` variant, looked up by name.
 *
 * Kept as a sibling map (not on the factory, not in the body) so domain
 * errors stay transport-agnostic. `satisfies Record<AiChatError['name'], number>`
 * enforces exhaustiveness: adding a variant to `AiChatError` without a
 * matching status here is a compile error.
 */
export const AiChatErrorStatus = {
	Unauthorized: 401,
	ProviderNotConfigured: 503,
	UnknownModel: 400,
	InsufficientCredits: 402,
	ModelRequiresPaidPlan: 403,
} as const satisfies Record<AiChatError['name'], number>;
