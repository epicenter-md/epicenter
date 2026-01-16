import { invoke } from '@tauri-apps/api/core';
import { stat } from '@tauri-apps/plugin-fs';
import { regex } from 'arkregex';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import {
	MOONSHINE_LANGUAGES,
	MOONSHINE_VARIANTS,
	type MoonshineLanguage,
	type MoonshineModelConfig,
	type MoonshineVariant,
} from './types';

/**
 * HuggingFace base URL for Moonshine models.
 * Models are distributed across different directories:
 * - ONNX models: onnx/merged/[variant]/quantized/
 * - Tokenizer: ctranslate2/tiny/ (shared across all models)
 */
const HF_BASE = 'https://huggingface.co/UsefulSensors/moonshine/resolve/main';

/**
 * Type-safe regex pattern for validating Moonshine model paths.
 * Matches paths ending with `moonshine-{variant}-{lang}`.
 *
 * Built from MOONSHINE_VARIANTS and MOONSHINE_LANGUAGES arrays for consistency.
 * The Rust side extracts variant from the path to determine model architecture.
 */
const MOONSHINE_DIR_PATTERN = regex.as<
	`${string}moonshine-${MoonshineVariant}-${MoonshineLanguage}`,
	{ captures: [MoonshineVariant, MoonshineLanguage] }
>(
	`moonshine-(${MOONSHINE_VARIANTS.join('|')})-(${MOONSHINE_LANGUAGES.join('|')})$`,
);

/**
 * Pre-built Moonshine models available for download from HuggingFace.
 * These are ONNX models using encoder-decoder architecture with KV caching.
 *
 * ## Directory Naming Convention
 *
 * Model directories MUST follow the format: `moonshine-{variant}-{lang}`
 * - variant: "tiny" or "base" (determines model architecture)
 * - lang: language code (e.g., "en", "ar", "zh")
 *
 * The Rust side extracts the variant from the directory name to determine
 * which MoonshineModelParams to use (tiny: 6 layers, base: 8 layers).
 *
 * ## Model Sizes
 *
 * - "tiny" models: 6 layers, head_dim=36 (~30 MB quantized)
 * - "base" models: 8 layers, head_dim=52 (~65 MB quantized)
 *
 * Note: Language-specific models (ar, zh, ja, ko, uk, vi, es) exist but only
 * have float versions available. We provide quantized English models for now
 * since they offer the best size/performance tradeoff.
 */
export const MOONSHINE_MODELS = [
	{
		id: 'moonshine-tiny-en',
		name: 'Moonshine Tiny (English)',
		description: 'Fast and efficient English transcription (~28 MB)',
		size: '~30 MB',
		sizeBytes: 30_166_481, // encoder + decoder + tokenizer
		engine: 'moonshine',
		language: 'en',
		directoryName: 'moonshine-tiny-en',
		files: [
			{
				url: `${HF_BASE}/onnx/merged/tiny/quantized/encoder_model.onnx`,
				filename: 'encoder_model.onnx',
				sizeBytes: 7_937_661,
			},
			{
				url: `${HF_BASE}/onnx/merged/tiny/quantized/decoder_model_merged.onnx`,
				filename: 'decoder_model_merged.onnx',
				sizeBytes: 20_243_286,
			},
			{
				url: `${HF_BASE}/ctranslate2/tiny/tokenizer.json`,
				filename: 'tokenizer.json',
				sizeBytes: 1_985_534,
			},
		],
	},
	{
		id: 'moonshine-base-en',
		name: 'Moonshine Base (English)',
		description: 'Higher accuracy English transcription (~65 MB)',
		size: '~65 MB',
		sizeBytes: 64_997_467, // encoder + decoder + tokenizer
		engine: 'moonshine',
		language: 'en',
		directoryName: 'moonshine-base-en',
		files: [
			{
				url: `${HF_BASE}/onnx/merged/base/quantized/encoder_model.onnx`,
				filename: 'encoder_model.onnx',
				sizeBytes: 20_513_063,
			},
			{
				url: `${HF_BASE}/onnx/merged/base/quantized/decoder_model_merged.onnx`,
				filename: 'decoder_model_merged.onnx',
				sizeBytes: 42_498_870,
			},
			{
				url: `${HF_BASE}/ctranslate2/tiny/tokenizer.json`,
				filename: 'tokenizer.json',
				sizeBytes: 1_985_534,
			},
		],
	},
] as const satisfies readonly MoonshineModelConfig[];

const MoonshineErrorType = type({
	name: "'AudioReadError' | 'FfmpegNotFoundError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});

export const MoonshineTranscriptionServiceLive = {
	async transcribe(
		audioBlob: Blob,
		{ modelPath }: { modelPath: string },
	): Promise<Result<string, WhisperingError>> {
		// Pre-validation
		if (!modelPath) {
			return WhisperingErr({
				title: 'Model Directory Required',
				description: 'Please select a Moonshine model directory in settings.',
				action: {
					type: 'link',
					label: 'Configure model',
					href: '/settings/transcription',
				},
			});
		}

		// Check if model directory exists and is a directory (single I/O call)
		const { data: stats } = await tryAsync({
			try: () => stat(modelPath),
			catch: () => Ok(null),
		});

		if (!stats) {
			return WhisperingErr({
				title: 'Model Directory Not Found',
				description: `The model directory "${modelPath}" does not exist.`,
				action: {
					type: 'link',
					label: 'Select model',
					href: '/settings/transcription',
				},
			});
		}

		if (!stats.isDirectory) {
			return WhisperingErr({
				title: 'Invalid Model Path',
				description:
					'Moonshine models must be directories containing model files.',
				action: {
					type: 'link',
					label: 'Select model directory',
					href: '/settings/transcription',
				},
			});
		}

		// Validate path ends with moonshine-{variant}-{lang}
		if (!MOONSHINE_DIR_PATTERN.test(modelPath)) {
			return WhisperingErr({
				title: 'Invalid Model Directory Name',
				description: `Model path must end with moonshine-{variant}-{lang} (e.g., "moonshine-tiny-en", "moonshine-base-en")`,
				action: {
					type: 'link',
					label: 'Select valid model',
					href: '/settings/transcription',
				},
			});
		}

		// Convert audio blob to byte array
		const arrayBuffer = await audioBlob.arrayBuffer();
		const audioData = Array.from(new Uint8Array(arrayBuffer));

		// Call Tauri command to transcribe with Moonshine
		// The Rust side extracts variant from the model path directory name
		const result = await tryAsync({
			try: () =>
				invoke<string>('transcribe_audio_moonshine', {
					audioData,
					modelPath,
				}),
			catch: (unknownError) => {
				const result = MoonshineErrorType(unknownError);
				if (result instanceof type.errors) {
					return WhisperingErr({
						title: 'Unexpected Moonshine Error',
						description: extractErrorMessage(unknownError),
						action: { type: 'more-details', error: unknownError },
					});
				}
				const error = result;

				switch (error.name) {
					case 'ModelLoadError':
						return WhisperingErr({
							title: 'Model Loading Error',
							description: error.message,
							action: {
								type: 'more-details',
								error: new Error(error.message),
							},
						});

					case 'FfmpegNotFoundError':
						return WhisperingErr({
							title: 'FFmpeg Not Installed',
							description:
								'Moonshine requires FFmpeg to convert audio formats. Please install FFmpeg or switch to CPAL recording at 16kHz.',
							action: {
								type: 'link',
								label: 'Install FFmpeg',
								href: '/install-ffmpeg',
							},
						});

					case 'AudioReadError':
						return WhisperingErr({
							title: 'Audio Read Error',
							description: error.message,
							action: {
								type: 'more-details',
								error: new Error(error.message),
							},
						});

					case 'TranscriptionError':
						return WhisperingErr({
							title: 'Transcription Error',
							description: error.message,
							action: {
								type: 'more-details',
								error: new Error(error.message),
							},
						});

					default:
						return WhisperingErr({
							title: 'Moonshine Error',
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

export type MoonshineTranscriptionService =
	typeof MoonshineTranscriptionServiceLive;
