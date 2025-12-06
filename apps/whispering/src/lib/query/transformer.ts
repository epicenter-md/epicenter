import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import {
	fromTaggedErr,
	WhisperingErr,
	type WhisperingError,
	type WhisperingResult,
} from '$lib/result';
import * as services from '$lib/services';
import type {
	Transformation,
	TransformationRunCompleted,
	TransformationRunFailed,
	TransformationStep,
} from '$lib/services/db';
import { settings } from '$lib/stores/settings.svelte';
import { sanitizeFilename } from '$lib/utils/filename';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import { defineMutation, queryClient } from './_client';
import { dbKeys } from './db';

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
		resultMutationFn: async ({
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
					return fromTaggedErr(transformationRunError, {
						title: '⚠️ Transformation failed',
						action: { type: 'more-details', error: transformationRunError },
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
		resultMutationFn: async ({
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
					recordingTitle: recording.title,
				});

			if (transformationRunError)
				return fromTaggedErr(transformationRunError, {
					title: '⚠️ Transformation failed',
					action: { type: 'more-details', error: transformationRunError },
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

async function handleStep({
	input,
	step,
	context,
}: {
	input: string;
	step: TransformationStep;
	context?: {
		recordingTitle?: string;
		transformationTitle?: string;
	};
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

		case 'file_output': {
			if (!window.__TAURI_INTERNALS__) {
				console.warn(
					'file_output step is only supported on desktop; skipping',
				);
				return Ok(input);
			}

			const outputDirectory = step['file_output.outputDirectory'];
			const filenameTemplate = step['file_output.filenameTemplate'];
			const fileExtension = step['file_output.fileExtension'];

			if (!outputDirectory.trim()) {
				return Err('Output directory not configured for file_output step');
			}

			const now = new Date();
			const dateStr = now.toISOString().slice(0, 10);
			const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
			const timestampStr = `${dateStr}T${timeStr}`;

			const variables = {
				date: dateStr,
				time: timeStr,
				timestamp: timestampStr,
				recording_title: context?.recordingTitle ?? 'untitled',
				transformation_title: context?.transformationTitle ?? 'transformation',
			};

			const filename = interpolateTemplate(
				asTemplateString(filenameTemplate),
				variables,
			);

			const sanitizedFilename = sanitizeFilename(filename);

			const { join } = await import('@tauri-apps/api/path');
			const { writeTextFile, mkdir } = await import('@tauri-apps/plugin-fs');

			try {
				await mkdir(outputDirectory, { recursive: true });
			} catch (mkdirError) {
				const errMsg = extractErrorMessage(mkdirError);
				if (!errMsg.toLowerCase().includes('already exists')) {
					return Err(`Failed to create output directory: ${errMsg}`);
				}
			}

			const ext = fileExtension.trim()
				? fileExtension.startsWith('.')
					? fileExtension
					: `.${fileExtension}`
				: '';
			const filePath = await join(
				outputDirectory,
				`${sanitizedFilename}${ext}`,
			);

			try {
				await writeTextFile(filePath, input);
			} catch (writeError) {
				return Err(
					`Failed to write file "${sanitizedFilename}${ext}": ${extractErrorMessage(writeError)}`,
				);
			}

			console.log(`[file_output] Wrote: ${filePath}`);
			return Ok(input);
		}

		default:
			return Err(`Unsupported step type: ${step.type}`);
	}
}

async function runTransformation({
	input,
	transformation,
	recordingId,
	recordingTitle,
}: {
	input: string;
	transformation: Transformation;
	recordingId: string | null;
	recordingTitle?: string;
}): Promise<
	Result<
		TransformationRunCompleted | TransformationRunFailed,
		TransformServiceError
	>
> {
	if (!input.trim()) {
		return TransformServiceErr({
			message: 'Empty input. Please enter some text to transform',
			cause: undefined,
			context: { input, transformationId: transformation.id },
		});
	}

	if (transformation.steps.length === 0) {
		return TransformServiceErr({
			message:
				'No steps configured. Please add at least one transformation step',
			cause: undefined,
			context: { transformation },
		});
	}

	const { data: transformationRun, error: createTransformationRunError } =
		await services.db.runs.create({
			transformationId: transformation.id,
			recordingId,
			input,
		});

	if (createTransformationRunError)
		return TransformServiceErr({
			message: 'Unable to start transformation run',
			cause: createTransformationRunError,
			context: {
				transformationId: transformation.id,
				recordingId,
				input,
				createTransformationRunError,
			},
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
				cause: addTransformationStepRunError,
				context: {
					transformationRun,
					stepId: step.id,
					input: currentInput,
					addTransformationStepRunError,
				},
			});

		const handleStepResult = await handleStep({
			input: currentInput,
			step,
			context: {
				recordingTitle,
				transformationTitle: transformation.title,
			},
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
					cause: markTransformationRunAndRunStepAsFailedError,
					context: {
						transformationRun,
						stepId: newTransformationStepRun.id,
						error: handleStepResult.error,
						markTransformationRunAndRunStepAsFailedError,
					},
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
				cause: markTransformationRunStepAsCompletedError,
				context: {
					transformationRun,
					stepRunId: newTransformationStepRun.id,
					output: handleStepOutput,
					markTransformationRunStepAsCompletedError,
				},
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
			cause: markTransformationRunAsCompletedError,
			context: {
				transformationRun,
				output: currentInput,
				markTransformationRunAsCompletedError,
			},
		});
	return Ok(markedCompletedTransformationRun);
}
