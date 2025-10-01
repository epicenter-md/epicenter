/**
 * Transcription service configurations
 */
import type { Settings } from '$lib/settings';

// Import SVG icons as strings
import groqIcon from '$lib/constants/icons/groq.svg?raw';
import ggmlIcon from '$lib/constants/icons/ggml.svg?raw';
import openaiIcon from '$lib/constants/icons/openai.svg?raw';
import elevenlabsIcon from '$lib/constants/icons/elevenlabs.svg?raw';
import speachesIcon from '$lib/constants/icons/speaches.svg?raw';
import deepgramIcon from '$lib/constants/icons/deepgram.svg?raw';
import {
	ELEVENLABS_TRANSCRIPTION_MODELS,
	type ElevenLabsModel,
} from '$lib/services/transcription/elevenlabs';
import { GROQ_MODELS, type GroqModel } from '$lib/services/transcription/groq';
import {
	OPENAI_TRANSCRIPTION_MODELS,
	type OpenAIModel,
} from '$lib/services/transcription/openai';
import {
	DEEPGRAM_TRANSCRIPTION_MODELS,
	type DeepgramModel,
} from '$lib/services/transcription/deepgram';

type TranscriptionModel =
	| OpenAIModel
	| GroqModel
	| ElevenLabsModel
	| DeepgramModel;

export const TRANSCRIPTION_SERVICE_IDS = [
	'whispercpp',
	'Groq',
	'OpenAI',
	'ElevenLabs',
	'Deepgram',
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
	{
		id: 'whispercpp',
		name: 'Whisper C++',
		icon: ggmlIcon,
		invertInDarkMode: true,
		description: 'Fast local transcription with no internet required',
		modelPathField: 'transcription.whispercpp.modelPath',
		location: 'local',
	},
	// Cloud services (API-based)
	{
		id: 'Groq',
		name: 'Groq',
		icon: groqIcon,
		invertInDarkMode: false, // Groq has a colored logo that works in both modes
		description: 'Lightning-fast cloud transcription',
		models: GROQ_MODELS,
		defaultModel: GROQ_MODELS[2],
		modelSettingKey: 'transcription.groq.model',
		apiKeyField: 'apiKeys.groq',
		location: 'cloud',
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

export type TranscriptionService = (typeof TRANSCRIPTION_SERVICES)[number];
