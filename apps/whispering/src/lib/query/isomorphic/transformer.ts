import { nanoid } from 'nanoid/non-secure';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import { defineMutation, queryClient } from '$lib/query/client';
import {
	WhisperingErr,
	type WhisperingError,
	type WhisperingResult,
} from '$lib/result';
import { services } from '$lib/services';
import type {
	Transformation,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationRunRunning,
	TransformationStep,
} from '$lib/services/isomorphic/db';
import { settings } from '$lib/state/settings.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import { dbKeys } from './db';
import { applySimplePunctuation } from './transformation-logic';

const { TransformServiceError, TransformServiceErr } = createTaggedError(
	'TransformServiceError',
);
type TransformServiceError = ReturnType<typeof TransformServiceError>;

const transformerKeys = {
	transformInput: ['transformer', 'transformInput'] as const,
	transformRecording: ['transformer', 'transformRecording'] as const,
};

export const transformer = {
	transformInput: defineMutation({
		mutationKey: transformerKeys.transformInput,
		mutationFn: async ({
			input,
			transformation,
		}: {
			input: string;
			transformation: Transformation;
		}): Promise<WhisperingResult<string>> => {
			const getTransformationOutput = async (): Promise<
				Result<string, WhisperingError>
			> => {
				const { data: transformationRun, error: transformationRunError } =
					await runTransformation({
						input,
						transformation,
						recordingId: null,
					});

				if (transformationRunError)
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						serviceError: transformationRunError,
					});

				if (transformationRun.status === 'failed') {
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						description: transformationRun.error,
						action: { type: 'more-details', error: transformationRun.error },
					});
				}

				if (!transformationRun.output) {
					return WhisperingErr({
						title: '⚠️ Transformation produced no output',
						description: 'The transformation completed but produced no output.',
					});
				}

				return Ok(transformationRun.output);
			};

			const transformationOutputResult = await getTransformationOutput();

			queryClient.invalidateQueries({
				queryKey: dbKeys.runs.byTransformationId(transformation.id),
			});
			queryClient.invalidateQueries({
				queryKey: dbKeys.transformations.byId(transformation.id),
			});

			return transformationOutputResult;
		},
	}),

	transformRecording: defineMutation({
		mutationKey: transformerKeys.transformRecording,
		mutationFn: async ({
			recordingId,
			transformation,
		}: {
			recordingId: string;
			transformation: Transformation;
		}): Promise<
			Result<
				TransformationRunCompleted | TransformationRunFailed,
				WhisperingError
			>
		> => {
			const { data: recording, error: getRecordingError } =
				await services.db.recordings.getById(recordingId);
			if (getRecordingError || !recording) {
				return WhisperingErr({
					title: '⚠️ Recording not found',
					description:
						getRecordingError?.message ??
						'Could not find the selected recording.',
				});
			}

			const { data: transformationRun, error: transformationRunError } =
				await runTransformation({
					input: recording.transcribedText,
					transformation,
					recordingId,
				});

			if (transformationRunError)
				return WhisperingErr({
					title: '⚠️ Transformation failed',
					serviceError: transformationRunError,
				});

			queryClient.invalidateQueries({
				queryKey: dbKeys.runs.byRecordingId(recordingId),
			});
			queryClient.invalidateQueries({
				queryKey: dbKeys.runs.byTransformationId(transformation.id),
			});
			queryClient.invalidateQueries({
				queryKey: dbKeys.transformations.byId(transformation.id),
			});

			return Ok(transformationRun);
		},
	}),
};

export async function handleStep({
	input,
	step,
}: {
	input: string;
	step: TransformationStep;
}): Promise<Result<string, string>> {
	switch (step.type) {
		case 'find_replace': {
			const findText = step['find_replace.findText'];
			const replaceText = step['find_replace.replaceText'];
			const useRegex = step['find_replace.useRegex'];

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
			const provider = step['prompt_transform.inference.provider'];
			const systemPrompt = interpolateTemplate(
				asTemplateString(step['prompt_transform.systemPromptTemplate']),
				{ input },
			);
			const userPrompt = interpolateTemplate(
				asTemplateString(step['prompt_transform.userPromptTemplate']),
				{ input },
			);

			switch (provider) {
				case 'OpenAI': {
					const { data: completionResponse, error: completionError } =
						await services.completions.openai.complete({
							apiKey: settings.value['apiKeys.openai'],
							systemPrompt,
							userPrompt,
							model: step['prompt_transform.inference.provider.OpenAI.model'],
						});

					if (completionError) {
						return Err(completionError.message);
					}

					return Ok(completionResponse);
				}

				case 'Groq': {
					const model = step['prompt_transform.inference.provider.Groq.model'];
					const { data: completionResponse, error: completionError } =
						await services.completions.groq.complete({
							apiKey: settings.value['apiKeys.groq'],
							model,
							systemPrompt,
							userPrompt,
						});

					if (completionError) {
						return Err(completionError.message);
					}

					return Ok(completionResponse);
				}

				case 'Anthropic': {
					const { data: completionResponse, error: completionError } =
						await services.completions.anthropic.complete({
							apiKey: settings.value['apiKeys.anthropic'],
							model:
								step['prompt_transform.inference.provider.Anthropic.model'],
							systemPrompt,
							userPrompt,
						});

					if (completionError) {
						return Err(completionError.message);
					}

					return Ok(completionResponse);
				}

				case 'Google': {
					const { data: completion, error: completionError } =
						await services.completions.google.complete({
							apiKey: settings.value['apiKeys.google'],
							model: step['prompt_transform.inference.provider.Google.model'],
							systemPrompt,
							userPrompt,
						});

					if (completionError) {
						return Err(completionError.message);
					}

					return Ok(completion);
				}

				case 'OpenRouter': {
					const { data: completionResponse, error: completionError } =
						await services.completions.openrouter.complete({
							apiKey: settings.value['apiKeys.openrouter'],
							model:
								step['prompt_transform.inference.provider.OpenRouter.model'],
							systemPrompt,
							userPrompt,
						});

					if (completionError) {
						return Err(completionError.message);
					}

					return Ok(completionResponse);
				}

				case 'Custom': {
					const model =
						step['prompt_transform.inference.provider.Custom.model']?.trim();

					// baseUrl is per-step because local LLM setups often have multiple endpoints
					// (Ollama, LM Studio, llama.cpp) running on different ports
					const stepBaseUrl =
						step['prompt_transform.inference.provider.Custom.baseUrl']?.trim();
					// Fall back to global default from Settings → API Keys → Custom section
					const defaultBaseUrl =
						settings.value['completion.custom.baseUrl']?.trim();
					// Use || so empty string falls back to next value (cleared field = use default)
					const baseUrl = stepBaseUrl || defaultBaseUrl || '';

					// API key is global because most local endpoints don't require auth
					const { data: completionResponse, error: completionError } =
						await services.completions.custom.complete({
							apiKey: settings.value['apiKeys.custom'],
							model,
							baseUrl,
							systemPrompt,
							userPrompt,
						});

					if (completionError) {
						return Err(completionError.message);
					}

					return Ok(completionResponse);
				}

				default:
					return Err(`Unsupported provider: ${provider}`);
			}
		}

		case 'simple_punctuation': {
			return Ok(applySimplePunctuation(input));
		}

		default:
			return Err(`Unsupported step type: ${step.type}`);
	}
}

async function runTransformation({
	input,
	transformation,
	recordingId,
}: {
	input: string;
	transformation: Transformation;
	recordingId: string | null;
}): Promise<
	Result<
		TransformationRunCompleted | TransformationRunFailed,
		TransformServiceError
	>
> {
	if (!input.trim()) {
		return TransformServiceErr({
			message: 'Empty input. Please enter some text to transform',
		});
	}

	if (transformation.steps.length === 0) {
		return TransformServiceErr({
			message:
				'No steps configured. Please add at least one transformation step',
		});
	}

	const transformationRun = {
		id: nanoid(),
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: new Date().toISOString(),
		completedAt: null,
		status: 'running',
		stepRuns: [],
	} satisfies TransformationRunRunning;

	const { error: createTransformationRunError } =
		await services.db.runs.create(transformationRun);

	if (createTransformationRunError)
		return TransformServiceErr({
			message: 'Unable to start transformation run',
		});

	let currentInput = input;

	for (const step of transformation.steps) {
		const {
			data: newTransformationStepRun,
			error: addTransformationStepRunError,
		} = await services.db.runs.addStep(transformationRun, {
			id: step.id,
			input: currentInput,
		});

		if (addTransformationStepRunError)
			return TransformServiceErr({
				message: 'Unable to initialize transformation step',
			});

		const handleStepResult = await handleStep({
			input: currentInput,
			step,
		});

		if (isErr(handleStepResult)) {
			const {
				data: markedFailedTransformationRun,
				error: markTransformationRunAndRunStepAsFailedError,
			} = await services.db.runs.failStep(
				transformationRun,
				newTransformationStepRun.id,
				handleStepResult.error,
			);
			if (markTransformationRunAndRunStepAsFailedError)
				return TransformServiceErr({
					message: 'Unable to save failed transformation step result',
				});
			return Ok(markedFailedTransformationRun);
		}

		const handleStepOutput = handleStepResult.data;

		const { error: markTransformationRunStepAsCompletedError } =
			await services.db.runs.completeStep(
				transformationRun,
				newTransformationStepRun.id,
				handleStepOutput,
			);

		if (markTransformationRunStepAsCompletedError)
			return TransformServiceErr({
				message: 'Unable to save completed transformation step result',
			});

		currentInput = handleStepOutput;
	}

	const {
		data: markedCompletedTransformationRun,
		error: markTransformationRunAsCompletedError,
	} = await services.db.runs.complete(transformationRun, currentInput);

	if (markTransformationRunAsCompletedError)
		return TransformServiceErr({
			message: 'Unable to save completed transformation run',
		});
	return Ok(markedCompletedTransformationRun);
}
