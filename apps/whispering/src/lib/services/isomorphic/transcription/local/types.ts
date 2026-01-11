/**
 * Supported languages for Moonshine models.
 * This is the source of truth for:
 * 1. The `language` field type in MoonshineModelConfig
 * 2. The regex validation pattern in moonshine.ts
 *
 * Moonshine supports 8 languages with varying model availability:
 * - tiny variants: en, ar, zh, ja, ko, uk, vi (quantized versions available)
 * - base variants: en, es (quantized versions available)
 *
 * Currently only English models are exposed. Other languages can be enabled
 * by uncommenting below once we're ready to support them.
 */
export const MOONSHINE_LANGUAGES = [
	'en',
	// 'ar',
	// 'zh',
	// 'ja',
	// 'ko',
	// 'es',
	// 'uk',
	// 'vi',
] as const;

/**
 * Valid language codes for Moonshine models.
 * Derived from MOONSHINE_LANGUAGES array.
 */
export type MoonshineLanguage = (typeof MOONSHINE_LANGUAGES)[number];

/**
 * Valid variant codes for Moonshine models.
 * Determines the model architecture (layer count, hidden dimensions).
 */
export const MOONSHINE_VARIANTS = ['tiny', 'base'] as const;

/**
 * Valid variant type for Moonshine models.
 */
export type MoonshineVariant = (typeof MOONSHINE_VARIANTS)[number];

/**
 * Base configuration for a local AI model that can be downloaded and used for transcription.
 */
type BaseModelConfig = {
	/** Unique identifier for the model */
	id: string;

	/** Display name for the model */
	name: string;

	/** Brief description of the model's capabilities */
	description: string;

	/** Human-readable file size (e.g., "850 MB", "1.5 GB") */
	size: string;

	/** Exact size in bytes for progress tracking */
	sizeBytes: number;
};

/**
 * Configuration for Whisper models, which consist of a single .bin file.
 */
export type WhisperModelConfig = BaseModelConfig & {
	engine: 'whispercpp';
	file: {
		/** URL to download the model file from */
		url: string;
		/** Filename to save the model as */
		filename: string;
	};
};

/**
 * Configuration for Parakeet models, which consist of multiple ONNX files in a directory structure.
 */
export type ParakeetModelConfig = BaseModelConfig & {
	engine: 'parakeet';
	/** Name of the directory where files will be stored */
	directoryName: string;
	/** Array of files that make up the model */
	files: Array<{
		/** URL to download this file from */
		url: string;
		/** Filename to save this file as */
		filename: string;
		/** Size of this individual file in bytes */
		sizeBytes: number;
	}>;
};

/**
 * Configuration for Moonshine models, which consist of ONNX encoder/decoder files in a directory.
 * Moonshine is optimized for fast, efficient transcription with support for 8 languages.
 *
 * ## Variant inference from directory name
 *
 * Moonshine's ONNX files don't self-describe their architecture (unlike Whisper .bin files
 * which contain metadata, or Parakeet which includes config.json). The variant ("tiny" or
 * "base") tells transcribe-rs the layer count and hidden dimensions needed to load the model.
 *
 * Rather than storing variant separately, we encode it in the `directoryName` (e.g.,
 * "moonshine-tiny-en", "moonshine-base-en") and extract it at transcription time using
 * `extractVariantFromPath()`. This avoids redundant metadata while keeping our download
 * configs simple.
 *
 * Variant architecture:
 * - "tiny": 6 layers, head_dim=36 (~30 MB quantized)
 * - "base": 8 layers, head_dim=52 (~65 MB quantized)
 */
export type MoonshineModelConfig = BaseModelConfig & {
	engine: 'moonshine';
	/** Language code for this model variant */
	language: MoonshineLanguage;
	/**
	 * Name of the directory where files will be stored.
	 * Convention: `moonshine-{variant}-{lang}` (e.g., "moonshine-tiny-en")
	 * The variant and language are extracted from this name at transcription time.
	 */
	directoryName: `moonshine-${MoonshineVariant}-${MoonshineLanguage}`;
	/** Array of ONNX files that make up the model */
	files: Array<{
		/** URL to download this file from */
		url: string;
		/** Filename to save this file as */
		filename: string;
		/** Size of this individual file in bytes */
		sizeBytes: number;
	}>;
};

/**
 * Configuration for Canary models using native Rust ONNX inference.
 * Canary supports language selection, unlike Parakeet!
 */
export type CanaryModelConfig = BaseModelConfig & {
	engine: 'canary';
	/** Name of the directory where model files will be stored */
	directoryName: string;
	/** Array of files that make up the model */
	files: readonly {
		/** URL to download this file from */
		url: string;
		/** Filename to save this file as */
		filename: string;
		/** Size of this individual file in bytes */
		sizeBytes: number;
	}[];
};

/**
 * Union type for all supported local model configurations.
 */
export type LocalModelConfig =
	| WhisperModelConfig
	| ParakeetModelConfig
	| MoonshineModelConfig
	| CanaryModelConfig;

/**
 * Checks if a model file size is valid (at least 90% of expected size).
 * Used to detect corrupted or incomplete downloads.
 */
export function isModelFileSizeValid(
	actualBytes: number,
	expectedBytes: number,
): boolean {
	return actualBytes >= expectedBytes * 0.9;
}
