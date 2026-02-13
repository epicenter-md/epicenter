/**
 * Transcription service configurations
 */

import deepgramIcon from '$lib/constants/icons/deepgram.svg?raw';
import elevenlabsIcon from '$lib/constants/icons/elevenlabs.svg?raw';
import ggmlIcon from '$lib/constants/icons/ggml.svg?raw';
// Import SVG icons as strings
import groqIcon from '$lib/constants/icons/groq.svg?raw';
import mistralIcon from '$lib/constants/icons/mistral.svg?raw';
import moonshineIcon from '$lib/constants/icons/moonshine.svg?raw';
import nvidiaIcon from '$lib/constants/icons/nvidia.svg?raw';
import openaiIcon from '$lib/constants/icons/openai.svg?raw';
import speachesIcon from '$lib/constants/icons/speaches.svg?raw';
import { IS_WINDOWS } from '$lib/constants/platform';
import type { Settings } from '$lib/settings';
import {
	DEEPGRAM_TRANSCRIPTION_MODELS,
	MAX_FILE_SIZE_MB as DEEPGRAM_MAX_FILE_SIZE_MB,
	type DeepgramModel,
} from './cloud/deepgram';
import {
	ELEVENLABS_TRANSCRIPTION_MODELS,
	MAX_FILE_SIZE_MB as ELEVENLABS_MAX_FILE_SIZE_MB,
	type ElevenLabsModel,
} from './cloud/elevenlabs';
import {
	GROQ_MODELS,
	MAX_FILE_SIZE_MB as GROQ_MAX_FILE_SIZE_MB,
	type GroqModel,
} from './cloud/groq';
import {
	MAX_FILE_SIZE_MB as MISTRAL_MAX_FILE_SIZE_MB,
	MISTRAL_TRANSCRIPTION_MODELS,
	type MistralModel,
} from './cloud/mistral';
import {
	MAX_FILE_SIZE_MB as OPENAI_MAX_FILE_SIZE_MB,
	OPENAI_TRANSCRIPTION_MODELS,
	type OpenAIModel,
} from './cloud/openai';

type TranscriptionModel =
	| OpenAIModel
	| GroqModel
	| ElevenLabsModel
	| DeepgramModel
	| MistralModel;

export const TRANSCRIPTION_SERVICE_IDS = [
	'whispercpp',
	'parakeet',
	'moonshine',
	'Groq',
	'OpenAI',
	'ElevenLabs',
	'Deepgram',
	'Mistral',
	'speaches',
	// 'owhisper',
] as const;

export type TranscriptionServiceId = (typeof TRANSCRIPTION_SERVICE_IDS)[number];

type BaseTranscriptionService = {
	id: TranscriptionServiceId;
	name: string;
	icon: string; // SVG string
	invertInDarkMode: boolean; // Whether to invert the icon in dark mode
	description?: string;
	maxFileSizeMB: number; // Maximum file size in megabytes
};

type CloudTranscriptionService = BaseTranscriptionService & {
	location: 'cloud';
	models: readonly TranscriptionModel[];
	defaultModel: TranscriptionModel;
	modelSettingKey: string;
	apiKeyField: keyof Settings;
};

type SelfHostedTranscriptionService = BaseTranscriptionService & {
	location: 'self-hosted';
	serverUrlField: keyof Settings;
};

type LocalTranscriptionService = BaseTranscriptionService & {
	location: 'local';
	modelPathField: keyof Settings;
};

type SatisfiedTranscriptionService =
	| CloudTranscriptionService
	| SelfHostedTranscriptionService
	| LocalTranscriptionService;

export const TRANSCRIPTION_SERVICES = [
	// Local services first (truly offline)
	// Whisper C++ is not available on Windows due to upstream whisper-rs limitations and MSVC runtime library conflicts
	...(IS_WINDOWS
		? []
		: [
				{
					id: 'whispercpp',
					name: 'Whisper C++',
					icon: ggmlIcon,
					invertInDarkMode: true,
					description: 'Fast local transcription with no internet required',
					modelPathField: 'transcription.whispercpp.modelPath',
					location: 'local',
					maxFileSizeMB: 500,
				} as const,
			]),
	{
		id: 'parakeet',
		name: 'Parakeet',
		icon: nvidiaIcon,
		invertInDarkMode: false,
		description: 'NVIDIA NeMo model for fast local transcription',
		modelPathField: 'transcription.parakeet.modelPath',
		location: 'local',
		maxFileSizeMB: 500,
	},
	// Moonshine is not available on Windows due to MSVC runtime library conflicts
	// between tokenizers/esaxx-rs (static CRT) and ort (dynamic CRT)
	...(IS_WINDOWS
		? []
		: [
				{
					id: 'moonshine',
					name: 'Moonshine',
					icon: moonshineIcon,
					invertInDarkMode: false,
					description: 'Efficient ONNX model by UsefulSensors',
					modelPathField: 'transcription.moonshine.modelPath',
					location: 'local',
					maxFileSizeMB: 500,
				} as const,
			]),
	// Cloud services (API-based)
	{
		id: 'Groq',
		name: 'Groq',
		icon: groqIcon,
		invertInDarkMode: false, // Groq has a colored logo that works in both modes
		description: 'Lightning-fast cloud transcription',
		models: GROQ_MODELS,
		defaultModel: GROQ_MODELS[1],
		modelSettingKey: 'transcription.groq.model',
		apiKeyField: 'apiKeys.groq',
		location: 'cloud',
		maxFileSizeMB: GROQ_MAX_FILE_SIZE_MB,
	},
	{
		id: 'OpenAI',
		name: 'OpenAI',
		icon: openaiIcon,
		invertInDarkMode: true,
		description: 'Industry-standard Whisper API',
		models: OPENAI_TRANSCRIPTION_MODELS,
		defaultModel: OPENAI_TRANSCRIPTION_MODELS[0],
		modelSettingKey: 'transcription.openai.model',
		apiKeyField: 'apiKeys.openai',
		location: 'cloud',
		maxFileSizeMB: OPENAI_MAX_FILE_SIZE_MB,
	},
	{
		id: 'ElevenLabs',
		name: 'ElevenLabs',
		icon: elevenlabsIcon,
		invertInDarkMode: true,
		description: 'Voice AI platform with transcription',
		models: ELEVENLABS_TRANSCRIPTION_MODELS,
		defaultModel: ELEVENLABS_TRANSCRIPTION_MODELS[0],
		modelSettingKey: 'transcription.elevenlabs.model',
		apiKeyField: 'apiKeys.elevenlabs',
		location: 'cloud',
		maxFileSizeMB: ELEVENLABS_MAX_FILE_SIZE_MB,
	},
	{
		id: 'Deepgram',
		name: 'Deepgram',
		icon: deepgramIcon,
		invertInDarkMode: true,
		description: 'Real-time speech recognition API',
		models: DEEPGRAM_TRANSCRIPTION_MODELS,
		defaultModel: DEEPGRAM_TRANSCRIPTION_MODELS[0],
		modelSettingKey: 'transcription.deepgram.model',
		apiKeyField: 'apiKeys.deepgram',
		location: 'cloud',
		maxFileSizeMB: DEEPGRAM_MAX_FILE_SIZE_MB,
	},
	{
		id: 'Mistral',
		name: 'Mistral AI',
		icon: mistralIcon,
		invertInDarkMode: false, // Mistral has colored branding
		description: 'Advanced Voxtral speech understanding',
		models: MISTRAL_TRANSCRIPTION_MODELS,
		defaultModel: MISTRAL_TRANSCRIPTION_MODELS[0],
		modelSettingKey: 'transcription.mistral.model',
		apiKeyField: 'apiKeys.mistral',
		location: 'cloud',
		maxFileSizeMB: MISTRAL_MAX_FILE_SIZE_MB,
	},
	// Self-hosted services
	{
		id: 'speaches',
		name: 'Speaches',
		icon: speachesIcon,
		invertInDarkMode: false, // Speaches has a colored logo
		description: 'Self-hosted transcription server',
		serverUrlField: 'transcription.speaches.baseUrl',
		location: 'self-hosted',
		maxFileSizeMB: 100,
	},
	// {
	// 	id: 'owhisper',
	// 	name: 'Owhisper',
	// 	icon: ServerIcon,
	// 	serverUrlField: 'transcription.owhisper.baseUrl',
	// 	location: 'self-hosted',
	// },
] as const satisfies SatisfiedTranscriptionService[];

export const TRANSCRIPTION_SERVICE_OPTIONS = TRANSCRIPTION_SERVICES.map(
	(service) => ({
		label: service.name,
		value: service.id,
	}),
);

export const TRANSCRIPTION_SERVICE_ID_TO_LABEL = Object.fromEntries(
	TRANSCRIPTION_SERVICES.map((s) => [s.id, s.name]),
) as Record<TranscriptionServiceId, string>;

export type TranscriptionService = (typeof TRANSCRIPTION_SERVICES)[number];

/**
 * Feature capabilities for each transcription service.
 * Used to conditionally enable/disable UI elements based on what each service supports.
 */
type ServiceCapabilities = {
	/**
	 * Whether the service accepts a system prompt / initial prompt for context.
	 * Prompts help the model recognize domain-specific terms, names, or style.
	 * Example: "This is a medical consultation discussing myocardial infarction."
	 */
	supportsPrompt: boolean;
	/**
	 * Whether the service accepts a temperature parameter (0.0-1.0).
	 * Temperature controls randomness: 0 is deterministic, 1 is more creative.
	 * Local models (transcribe-rs) do not support this parameter.
	 */
	supportsTemperature: boolean;
	/**
	 * Whether the service accepts a target language hint.
	 * When false, the service auto-detects the language (e.g., Parakeet).
	 */
	supportsLanguage: boolean;
};

/**
 * Declares what features each transcription service supports.
 *
 * Use this to conditionally enable/disable UI elements based on the
 * currently selected service. Lookup by service ID:
 *
 * @example
 * ```ts
 * const caps = TRANSCRIPTION_SERVICE_CAPABILITIES[selectedServiceId];
 * if (caps.supportsPrompt) { ... }
 * ```
 */
export const TRANSCRIPTION_SERVICE_CAPABILITIES = {
	whispercpp: {
		supportsPrompt: true,
		supportsTemperature: false,
		supportsLanguage: true,
	},
	parakeet: {
		supportsPrompt: false,
		supportsTemperature: false,
		supportsLanguage: false,
	},
	moonshine: {
		supportsPrompt: false,
		supportsTemperature: false,
		supportsLanguage: false,
	},
	Groq: {
		supportsPrompt: true,
		supportsTemperature: true,
		supportsLanguage: true,
	},
	OpenAI: {
		supportsPrompt: true,
		supportsTemperature: true,
		supportsLanguage: true,
	},
	ElevenLabs: {
		supportsPrompt: true,
		supportsTemperature: true,
		supportsLanguage: true,
	},
	Deepgram: {
		supportsPrompt: true,
		supportsTemperature: true,
		supportsLanguage: true,
	},
	Mistral: {
		supportsPrompt: true,
		supportsTemperature: true,
		supportsLanguage: true,
	},
	speaches: {
		supportsPrompt: true,
		supportsTemperature: true,
		supportsLanguage: true,
	},
} as const satisfies Record<TranscriptionServiceId, ServiceCapabilities>;

/**
 * Get the maximum file size in bytes for a transcription service.
 * Returns the limit for the specified service, or undefined if service not found.
 *
 * @param serviceId - The transcription service ID
 * @returns Maximum file size in bytes, or undefined
 */
export function getServiceMaxFileSize(
	serviceId: TranscriptionServiceId,
): number | undefined {
	const service = TRANSCRIPTION_SERVICES.find((s) => s.id === serviceId);
	return service ? service.maxFileSizeMB * 1024 * 1024 : undefined;
}
