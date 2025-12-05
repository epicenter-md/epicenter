/**
 * Transcription service configurations
 */

import deepgramIcon from '$lib/constants/icons/deepgram.svg?raw';
import elevenlabsIcon from '$lib/constants/icons/elevenlabs.svg?raw';
import ggmlIcon from '$lib/constants/icons/ggml.svg?raw';
// Import SVG icons as strings
import groqIcon from '$lib/constants/icons/groq.svg?raw';
import mistralIcon from '$lib/constants/icons/mistral.svg?raw';
import nvidiaIcon from '$lib/constants/icons/nvidia.svg?raw';
import openaiIcon from '$lib/constants/icons/openai.svg?raw';
import speachesIcon from '$lib/constants/icons/speaches.svg?raw';
import type { Settings } from '$lib/settings';
import {
	DEEPGRAM_TRANSCRIPTION_MODELS,
	type DeepgramModel,
} from './cloud/deepgram';
import {
	ELEVENLABS_TRANSCRIPTION_MODELS,
	type ElevenLabsModel,
} from './cloud/elevenlabs';
import { GROQ_MODELS, type GroqModel } from './cloud/groq';
import {
	MISTRAL_TRANSCRIPTION_MODELS,
	type MistralModel,
} from './cloud/mistral';
import { OPENAI_TRANSCRIPTION_MODELS, type OpenAIModel } from './cloud/openai';

type TranscriptionModel =
	| OpenAIModel
	| GroqModel
	| ElevenLabsModel
	| DeepgramModel
	| MistralModel;

export const TRANSCRIPTION_SERVICE_IDS = [
	'whispercpp',
	'parakeet',
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
	{
		id: 'parakeet',
		name: 'Parakeet',
		icon: nvidiaIcon,
		invertInDarkMode: false,
		description: 'NVIDIA NeMo model for fast local transcription',
		modelPathField: 'transcription.parakeet.modelPath',
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
		defaultModel: GROQ_MODELS[1],
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
