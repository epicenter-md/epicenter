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
const CURRENT_TRANSFORMATION_STEP_VERSION = 2 as const;

// ============================================================================
// SHARED BASE FIELDS
// ============================================================================
// These are shared between V1 and V2. If V3 needs different base fields,
// create a new base or define V3 from scratch.
// ============================================================================

/**
 * Base fields shared between TransformationStep V1 and V2.
 * FROZEN for V1/V2: Do not modify without considering impact on both versions.
 *
 * Uses arktype's type() directly so we can use .merge() for composition.
 */
const TransformationStepBase = type({
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
});

/**
 * Fields for Transformation. These have NOT changed since the initial schema.
 * Only TransformationStep has versioning (V1 → V2 added Custom provider fields).
 *
 * If a future version adds/changes Transformation-level fields (not just steps),
 * introduce versioning at that point.
 *
 * Uses arktype's type() directly so we can use .merge() for composition.
 */
const TransformationBase = type({
	id: 'string',
	title: 'string',
	description: 'string',
	createdAt: 'string',
	updatedAt: 'string',
});

// ============================================================================
// VERSION 1 (FROZEN)
// ============================================================================

/**
 * V1: Original schema without Custom provider fields.
 * Old data has no version field, so we default to 1.
 *
 * FROZEN: Do not modify. This represents the historical V1 schema.
 */
const TransformationStepV1 = TransformationStepBase.merge({
	version: '1 = 1',
});

export type TransformationStepV1 = typeof TransformationStepV1.infer;

/**
 * Transformation type containing V1 steps (before Custom provider fields).
 * Used only for typing old data during Dexie migration in web.ts.
 *
 * Note: The Transformation fields themselves are unchanged; only the step
 * schema differs between "V1" and "V2".
 */
export type TransformationV1 = {
	id: string;
	title: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	steps: TransformationStepV1[];
};

// ============================================================================
// VERSION 2 (CURRENT)
// ============================================================================

/**
 * V2: Added Custom provider fields for local LLM endpoints.
 * - Custom.model: Model name for custom endpoints
 * - Custom.baseUrl: Per-step base URL (falls back to global setting)
 *
 * CURRENT VERSION: This is the latest schema.
 */
const TransformationStepV2 = TransformationStepBase.merge({
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

/**
 * Current Transformation schema with V2 steps.
 *
 * Note: The Transformation fields themselves are unchanged from V1;
 * "V2" refers to the step schema version contained within.
 */
const TransformationV2 = TransformationBase.merge({
	steps: [TransformationStepV2, '[]'],
});

export type TransformationV2 = typeof TransformationV2.infer;

// ============================================================================
// MIGRATING VALIDATORS
// ============================================================================
// These accept any version and migrate to the latest (V2).
// Use these when reading data that might be from an older schema version.
// ============================================================================

/**
 * Migrates a TransformationStep from V1 to V2.
 */
function migrateStepV1ToV2(step: TransformationStepV1): TransformationStepV2 {
	return {
		...step,
		version: 2,
		'prompt_transform.inference.provider.Custom.model': '',
		'prompt_transform.inference.provider.Custom.baseUrl': '',
	};
}

/**
 * TransformationStep validator with automatic migration.
 * Accepts V1 or V2 and always outputs V2.
 */
export const TransformationStep = TransformationStepV1.or(
	TransformationStepV2,
).pipe((step): TransformationStepV2 => {
	if (step.version === 1) {
		return migrateStepV1ToV2(step);
	}
	return step;
});

export type TransformationStep = TransformationStepV2;

/**
 * Transformation validator with automatic step migration.
 * Accepts transformations with V1 or V2 steps and migrates all steps to V2.
 * Use this when reading data that might contain old schema versions.
 */
export const Transformation = TransformationBase.merge({
	steps: [TransformationStep, '[]'],
});

export type Transformation = TransformationV2;

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function generateDefaultTransformation(): TransformationV2 {
	const now = new Date().toISOString();
	return {
		id: nanoid(),
		title: '',
		description: '',
		steps: [],
		createdAt: now,
		updatedAt: now,
	};
}

export function generateDefaultTransformationStep(): TransformationStepV2 {
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
