import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import { services } from '$lib/services';
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { transformationRuns } from '$lib/state/transformation-runs.svelte';
import { transformationStepRuns } from '$lib/state/transformation-step-runs.svelte';
import { transformationSteps } from '$lib/state/transformation-steps.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import type {
	Transformation,
	TransformationRun,
	TransformationStep,
	TransformationStepRun,
} from '$lib/workspace';

/**
 * Config map for standard completion providers that share the same
 * `{ apiKey, model, systemPrompt, userPrompt }` call signature.
 * Custom is handled separately because it has per-step baseUrl logic.
 */
const STANDARD_PROVIDER_CONFIG = {
	OpenAI: {
		service: services.completions.openai,
		apiKeyPath: 'apiKeys.openai',
		modelKey: 'openaiModel',
	},
	Groq: {
		service: services.completions.groq,
		apiKeyPath: 'apiKeys.groq',
		modelKey: 'groqModel',
	},
	Anthropic: {
		service: services.completions.anthropic,
		apiKeyPath: 'apiKeys.anthropic',
		modelKey: 'anthropicModel',
	},
	Google: {
		service: services.completions.google,
		apiKeyPath: 'apiKeys.google',
		modelKey: 'googleModel',
	},
	OpenRouter: {
		service: services.completions.openrouter,
		apiKeyPath: 'apiKeys.openrouter',
		modelKey: 'openrouterModel',
	},
} as const satisfies Record<
	string,
	{
		service: {
			complete: (opts: {
				apiKey: string;
				model: string;
				systemPrompt: string;
				userPrompt: string;
			}) => Promise<Result<string, { message: string }>>;
		};
		apiKeyPath: DeviceConfigKey;
		modelKey: keyof TransformationStep;
	}
>;

export const TransformError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	NoSteps: ({ message }: { message: string }) => ({ message }),
	StepFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;

type StepError = string | { message: string };

async function handleStep({
	input,
	step,
}: {
	input: string;
	step: TransformationStep;
}): Promise<Result<string, StepError>> {
	switch (step.type) {
		case 'find_replace': {
			const { findText, replaceText, useRegex } = step;

			if (useRegex) {
				try {
					const regex = new RegExp(findText, 'g');
					return Ok(input.replace(regex, replaceText));
				} catch (error) {
					return Err(`Invalid regex pattern: ${extractErrorMessage(error)}`);
				}
			}

			return Ok(input.replaceAll(findText, replaceText));
		}

		case 'prompt_transform': {
			const { inferenceProvider, systemPromptTemplate, userPromptTemplate } =
				step;
			const systemPrompt = interpolateTemplate(
				asTemplateString(systemPromptTemplate),
				{ input },
			);
			const userPrompt = interpolateTemplate(
				asTemplateString(userPromptTemplate),
				{ input },
			);

			if (inferenceProvider === 'Custom') {
				const model = step.customModel?.trim();
				const stepBaseUrl = step.customBaseUrl?.trim();
				const defaultBaseUrl = deviceConfig
					.get('completion.custom.baseUrl')
					?.trim();
				const baseUrl = stepBaseUrl || defaultBaseUrl || '';

				return services.completions.custom.complete({
					apiKey: deviceConfig.get('apiKeys.custom'),
					model,
					baseUrl,
					systemPrompt,
					userPrompt,
				});
			}

			const config = STANDARD_PROVIDER_CONFIG[inferenceProvider];
			if (!config) return Err(`Unsupported provider: ${inferenceProvider}`);

			return config.service.complete({
				apiKey: deviceConfig.get(config.apiKeyPath),
				model: step[config.modelKey] as string,
				systemPrompt,
				userPrompt,
			});
		}

		default:
			return Err(`Unsupported step type: ${step.type}`);
	}
}

/**
 * Run a transformation pipeline. Persists run + step-run records to workspace
 * state as it progresses (including the failed state when a step throws);
 * the returned Result is purely for caller control flow. Pure orchestration;
 * no toasts, no notifications.
 */
export async function runTransformation({
	input,
	transformation,
	recordingId,
}: {
	input: string;
	transformation: Transformation;
	recordingId: string | null;
}): Promise<Result<string, TransformError>> {
	if (!input.trim()) {
		return TransformError.InvalidInput({
			message: 'Empty input. Please enter some text to transform',
		});
	}

	const steps = transformationSteps.getByTransformationId(transformation.id);

	if (steps.length === 0) {
		return TransformError.NoSteps({
			message:
				'No steps configured. Please add at least one transformation step',
		});
	}

	const now = new Date().toISOString();
	const runId = nanoid();

	const transformationRun = {
		id: runId,
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: now,
		result: { status: 'running' },
	} satisfies TransformationRun;

	transformationRuns.set(transformationRun);

	let currentInput = input;

	for (const [stepIndex, step] of steps.entries()) {
		const stepRunId = nanoid();
		const stepRun = {
			id: stepRunId,
			transformationRunId: runId,
			stepId: step.id,
			order: stepIndex,
			input: currentInput,
			startedAt: new Date().toISOString(),
			result: { status: 'running' },
		} satisfies TransformationStepRun;
		transformationStepRuns.set(stepRun);

		let handleStepResult: Result<string, StepError>;
		try {
			handleStepResult = await handleStep({
				input: currentInput,
				step,
			});
		} catch (error) {
			handleStepResult = Err(extractErrorMessage(error));
		}

		if (isErr(handleStepResult)) {
			const stepError = extractErrorMessage(handleStepResult.error);
			const failedNow = new Date().toISOString();
			transformationStepRuns.set({
				...stepRun,
				result: {
					status: 'failed',
					completedAt: failedNow,
					error: stepError,
				},
			});
			transformationRuns.set({
				...transformationRun,
				result: {
					status: 'failed',
					completedAt: failedNow,
					error: stepError,
				},
			} satisfies TransformationRun);
			return TransformError.StepFailed({ message: stepError });
		}

		const handleStepOutput = handleStepResult.data;

		transformationStepRuns.set({
			...stepRun,
			result: {
				status: 'completed',
				completedAt: new Date().toISOString(),
				output: handleStepOutput,
			},
		});

		currentInput = handleStepOutput;
	}

	transformationRuns.set({
		...transformationRun,
		result: {
			status: 'completed',
			completedAt: new Date().toISOString(),
			output: currentInput,
		},
	} satisfies TransformationRun);
	return Ok(currentInput);
}
