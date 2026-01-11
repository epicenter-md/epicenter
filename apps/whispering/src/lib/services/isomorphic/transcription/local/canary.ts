import { invoke } from '@tauri-apps/api/core';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import type { CanaryModelConfig } from './types';

/**
 * Canary-1B-v2 model configuration.
 * Unlike Parakeet, Canary supports language selection!
 *
 * Model files required:
 * - encoder-model.int8.onnx (~859 MB)
 * - decoder-model.int8.onnx (~170 MB)
 * - vocab.txt (208 KB)
 * - config.json (68 B)
 * - nemo128.onnx (141 KB) - audio preprocessor
 */
export const CANARY_MODELS = [
	{
		id: 'canary-1b-v2-int8',
		name: 'Canary 1B v2 (INT8)',
		description: 'NVIDIA NeMo model with language support',
		size: '~1 GB',
		sizeBytes: 1_029_000_000,
		engine: 'canary',
		directoryName: 'canary-1b-v2-int8',
		files: [
			{
				url: 'https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/encoder-model.int8.onnx',
				filename: 'encoder-model.int8.onnx',
				sizeBytes: 859_000_000,
			},
			{
				url: 'https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/decoder-model.int8.onnx',
				filename: 'decoder-model.int8.onnx',
				sizeBytes: 170_000_000,
			},
			{
				url: 'https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/vocab.txt',
				filename: 'vocab.txt',
				sizeBytes: 208_000,
			},
			{
				url: 'https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/config.json',
				filename: 'config.json',
				sizeBytes: 68,
			},
			{
				url: 'https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/main/nemo128.onnx',
				filename: 'nemo128.onnx',
				sizeBytes: 141_000,
			},
		],
	},
] as const satisfies readonly CanaryModelConfig[];

/**
 * Supported languages for Canary-1B-v2
 */
export const CANARY_LANGUAGES = [
	{ code: 'fr', name: 'French' },
	{ code: 'en', name: 'English' },
	{ code: 'de', name: 'German' },
	{ code: 'es', name: 'Spanish' },
	{ code: 'it', name: 'Italian' },
	{ code: 'pt', name: 'Portuguese' },
	{ code: 'nl', name: 'Dutch' },
	{ code: 'pl', name: 'Polish' },
	{ code: 'ru', name: 'Russian' },
	{ code: 'uk', name: 'Ukrainian' },
	{ code: 'cs', name: 'Czech' },
	{ code: 'ro', name: 'Romanian' },
	{ code: 'hu', name: 'Hungarian' },
	{ code: 'bg', name: 'Bulgarian' },
	{ code: 'hr', name: 'Croatian' },
	{ code: 'sk', name: 'Slovak' },
	{ code: 'sl', name: 'Slovenian' },
	{ code: 'et', name: 'Estonian' },
	{ code: 'lv', name: 'Latvian' },
	{ code: 'lt', name: 'Lithuanian' },
	{ code: 'da', name: 'Danish' },
	{ code: 'sv', name: 'Swedish' },
	{ code: 'fi', name: 'Finnish' },
	{ code: 'el', name: 'Greek' },
	{ code: 'mt', name: 'Maltese' },
] as const;

export type CanaryLanguageCode = (typeof CANARY_LANGUAGES)[number]['code'];

const CanaryErrorType = type({
	name: "'AudioReadError' | 'FfmpegNotFoundError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});

export const CanaryTranscriptionServiceLive = {
	/**
	 * Transcribe audio using Canary-1B-v2 with language support
	 * Uses native Rust ONNX inference (no Python required!)
	 */
	async transcribe(
		audioBlob: Blob,
		options: {
			modelPath: string;
			language?: string;
		},
	): Promise<Result<string, WhisperingError>> {
		// Pre-validation
		if (!options.modelPath) {
			return WhisperingErr({
				title: '📁 Model Directory Required',
				description: 'Please select a Canary model directory in settings.',
				action: {
					type: 'link',
					label: 'Configure model',
					href: '/settings/transcription',
				},
			});
		}

		// Check if model directory exists
		const { data: isExists } = await tryAsync({
			try: () => exists(options.modelPath),
			catch: () => Ok(false),
		});

		if (!isExists) {
			return WhisperingErr({
				title: '❌ Model Directory Not Found',
				description: `The model directory "${options.modelPath}" does not exist.`,
				action: {
					type: 'link',
					label: 'Select model',
					href: '/settings/transcription',
				},
			});
		}

		// Check if it's actually a directory
		const { data: stats } = await tryAsync({
			try: () => stat(options.modelPath),
			catch: () => Ok(null),
		});

		if (!stats || !stats.isDirectory) {
			return WhisperingErr({
				title: '❌ Invalid Model Path',
				description:
					'Canary models must be directories containing model files.',
				action: {
					type: 'link',
					label: 'Select model directory',
					href: '/settings/transcription',
				},
			});
		}

		// Convert audio blob to byte array
		const arrayBuffer = await audioBlob.arrayBuffer();
		const audioData = Array.from(new Uint8Array(arrayBuffer));

		// Default to French if no language specified
		const language = options.language || 'fr';

		// Call Tauri command to transcribe with Canary
		// KEY FEATURE: Canary supports language selection via the language parameter!
		const result = await tryAsync({
			try: () =>
				invoke<string>('transcribe_audio_canary', {
					audioData: audioData,
					modelPath: options.modelPath,
					language: language,
				}),
			catch: (unknownError) => {
				const result = CanaryErrorType(unknownError);
				if (result instanceof type.errors) {
					return WhisperingErr({
						title: '❌ Unexpected Canary Error',
						description: extractErrorMessage(unknownError),
						action: { type: 'more-details', error: unknownError },
					});
				}
				const error = result;

				switch (error.name) {
					case 'ModelLoadError':
						return WhisperingErr({
							title: '🤖 Model Loading Error',
							description: error.message,
							action: {
								type: 'more-details',
								error: new Error(error.message),
							},
						});

					case 'FfmpegNotFoundError':
						return WhisperingErr({
							title: '🛠️ FFmpeg Not Installed',
							description:
								'Canary requires FFmpeg to convert audio formats. Please install FFmpeg or use recordings at 16kHz.',
							action: {
								type: 'link',
								label: 'Install FFmpeg',
								href: '/install-ffmpeg',
							},
						});

					case 'AudioReadError':
						return WhisperingErr({
							title: '🔊 Audio Read Error',
							description: error.message,
							action: {
								type: 'more-details',
								error: new Error(error.message),
							},
						});

					case 'TranscriptionError':
						return WhisperingErr({
							title: '❌ Transcription Error',
							description: error.message,
							action: {
								type: 'more-details',
								error: new Error(error.message),
							},
						});

					default:
						return WhisperingErr({
							title: '❌ Canary Error',
							description: 'An unexpected error occurred.',
							action: {
								type: 'more-details',
								error: new Error(String(error)),
							},
						});
				}
			},
		});

		return result;
	},
};

export type CanaryTranscriptionService = typeof CanaryTranscriptionServiceLive;
