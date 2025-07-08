import type {
	ANTHROPIC_INFERENCE_MODELS,
	GOOGLE_INFERENCE_MODELS,
	GROQ_INFERENCE_MODELS,
	INFERENCE_PROVIDERS,
	OPENAI_INFERENCE_MODELS,
} from '$lib/constants/inference';
import { nanoid } from 'nanoid/non-secure';

export const TRANSFORMATION_STEP_TYPES = [
	'prompt_transform',
	'find_replace',
] as const;

export const TRANSFORMATION_STEP_TYPES_TO_LABELS = {
	prompt_transform: 'Prompt Transform',
	find_replace: 'Find Replace',
} as const satisfies Record<(typeof TRANSFORMATION_STEP_TYPES)[number], string>;

export type Transformation = {
	id: string;
	title: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * It can be one of several types of text transformations:
	 * - find_replace: Replace text patterns with new text
	 * - prompt_transform: Use AI to transform text based on prompts
	 */
	steps: {
		id: string;
		// For now, steps don't need titles or descriptions. They can be computed from the type as "Find and Replace" or "Prompt Transform"
		type: (typeof TRANSFORMATION_STEP_TYPES)[number];

		'prompt_transform.inference.provider': (typeof INFERENCE_PROVIDERS)[number];
		'prompt_transform.inference.provider.OpenAI.model': (typeof OPENAI_INFERENCE_MODELS)[number];
		'prompt_transform.inference.provider.Groq.model': (typeof GROQ_INFERENCE_MODELS)[number];
		'prompt_transform.inference.provider.Anthropic.model': (typeof ANTHROPIC_INFERENCE_MODELS)[number];
		'prompt_transform.inference.provider.Google.model': (typeof GOOGLE_INFERENCE_MODELS)[number];

		'prompt_transform.systemPromptTemplate': string;
		'prompt_transform.userPromptTemplate': string;

		'find_replace.findText': string;
		'find_replace.replaceText': string;
		'find_replace.useRegex': boolean;
	}[];
};

export type TransformationStep = Transformation['steps'][number];
export type InsertTransformationStep = Omit<
	TransformationStep,
	'createdAt' | 'updatedAt'
>;

export function generateDefaultTransformation(): Transformation {
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

export function generateDefaultTransformationStep(): TransformationStep {
	return {
		id: nanoid(),
		type: 'prompt_transform',
		'prompt_transform.inference.provider': 'Google',
		'prompt_transform.inference.provider.OpenAI.model': 'gpt-4o',
		'prompt_transform.inference.provider.Groq.model': 'llama-3.3-70b-versatile',
		'prompt_transform.inference.provider.Anthropic.model': 'claude-sonnet-4-0',
		'prompt_transform.inference.provider.Google.model': 'gemini-2.5-flash',

		'prompt_transform.systemPromptTemplate': '',
		'prompt_transform.userPromptTemplate': '',

		'find_replace.findText': '',
		'find_replace.replaceText': '',
		'find_replace.useRegex': false,
	};
}
