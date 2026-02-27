import { type } from 'arktype';
import { nanoid } from 'nanoid/non-secure';
import { TRANSFORMATION_STEP_TYPES } from '$lib/constants/database';
import {
	ANTHROPIC_INFERENCE_MODELS,
	GOOGLE_INFERENCE_MODELS,
	GROQ_INFERENCE_MODELS,
	INFERENCE_PROVIDER_IDS,
	OPENAI_INFERENCE_MODELS,
} from '$lib/constants/inference';

/**
 * The current version of the TransformationStep schema.
 * Increment this when adding new fields or making breaking changes.
 */
const CURRENT_TRANSFORMATION_STEP_VERSION = 3 as const;

// ============================================================================
// VERSION 1 (FROZEN)
// ============================================================================

/**
 * V1: Original schema without Custom provider fields.
 * Old data has no version field, so we default to 1.
 *
 * FROZEN: Do not modify. This represents the historical V1 schema.
 */
export const TransformationStepV1 = type({
	id: 'string',
	type: type.enumerated(...TRANSFORMATION_STEP_TYPES),
	'prompt_transform.inference.provider': type.enumerated(
		...INFERENCE_PROVIDER_IDS,
	),
	'prompt_transform.inference.provider.OpenAI.model': type.enumerated(
		...OPENAI_INFERENCE_MODELS,
	),
	'prompt_transform.inference.provider.Groq.model': type.enumerated(
		...GROQ_INFERENCE_MODELS,
	),
	'prompt_transform.inference.provider.Anthropic.model': type.enumerated(
		...ANTHROPIC_INFERENCE_MODELS,
	),
	'prompt_transform.inference.provider.Google.model': type.enumerated(
		...GOOGLE_INFERENCE_MODELS,
	),
	// OpenRouter model is a free string (user can enter any model)
	'prompt_transform.inference.provider.OpenRouter.model': 'string',
	'prompt_transform.systemPromptTemplate': 'string',
	'prompt_transform.userPromptTemplate': 'string',
	'find_replace.findText': 'string',
	'find_replace.replaceText': 'string',
	'find_replace.useRegex': 'boolean',
	version: '1 = 1',
});

export type TransformationStepV1 = typeof TransformationStepV1.infer;

// ============================================================================
// VERSION 2 (FROZEN)
// ============================================================================

/**
 * V2: Added Custom provider fields for local LLM endpoints.
 * Extends V1 with:
 * - Custom.model: Model name for custom endpoints
 * - Custom.baseUrl: Per-step base URL (falls back to global setting)
 *
 * CURRENT VERSION: This is the latest schema.
 */
export const TransformationStepV2 = TransformationStepV1.merge({
	version: '2',
	/** Custom provider for local LLM endpoints (Ollama, LM Studio, llama.cpp, etc.) */
	'prompt_transform.inference.provider.Custom.model': 'string',
	/**
	 * Per-step base URL for custom endpoints. Allows different steps to use
	 * different local services (e.g., Ollama on :11434, LM Studio on :1234).
	 * Falls back to global `completion.Custom.baseUrl` setting if empty.
	 */
	'prompt_transform.inference.provider.Custom.baseUrl': 'string',
});

export type TransformationStepV2 = typeof TransformationStepV2.infer;

// ============================================================================
// VERSION 3 (CURRENT)
// ============================================================================

/**
 * V3: Added 'simple_punctuation' type support.
 * Structure is identical to V2, just bumped version number to track schema evolution.
 */
export const TransformationStepV3 = TransformationStepV2.merge({
	version: '3',
});

export type TransformationStepV3 = typeof TransformationStepV3.infer;

// ============================================================================
// MIGRATING VALIDATOR
// ============================================================================

/**
 * TransformationStep validator with automatic migration.
 * Accepts V1 or V2 and always outputs V2.
 */
export const TransformationStep = TransformationStepV1.or(TransformationStepV2)
	.or(TransformationStepV3)
	.pipe((step): TransformationStepV3 => {
	if (step.version === 1) {
		return {
			...step,
			version: 3,
			'prompt_transform.inference.provider.Custom.model': '',
			'prompt_transform.inference.provider.Custom.baseUrl': '',
		};
	}
	if (step.version === 2) {
		return {
			...step,
			version: 3,
		};
	}
	return step;
});

export type TransformationStep = TransformationStepV3;

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function generateDefaultTransformationStep(): TransformationStep {
	return {
		version: CURRENT_TRANSFORMATION_STEP_VERSION,
		id: nanoid(),
		type: 'prompt_transform',
		'prompt_transform.inference.provider': 'Google',
		'prompt_transform.inference.provider.OpenAI.model': 'gpt-4o',
		'prompt_transform.inference.provider.Groq.model': 'llama-3.3-70b-versatile',
		'prompt_transform.inference.provider.Anthropic.model': 'claude-sonnet-4-0',
		'prompt_transform.inference.provider.Google.model': 'gemini-2.5-flash',
		'prompt_transform.inference.provider.OpenRouter.model':
			'mistralai/mixtral-8x7b',
		// Empty strings for Custom provider - user must configure when switching to Custom
		// baseUrl falls back to global setting in transformer.ts
		'prompt_transform.inference.provider.Custom.model': '',
		'prompt_transform.inference.provider.Custom.baseUrl': '',

		'prompt_transform.systemPromptTemplate': '',
		'prompt_transform.userPromptTemplate': '',

		'find_replace.findText': '',
		'find_replace.replaceText': '',
		'find_replace.useRegex': false,
	};
}
