/**
 * Transcription service configurations
 */
import type { Settings } from '$lib/settings';
import { CloudIcon, HexagonIcon, PauseIcon, ServerIcon } from 'lucide-svelte';
import {
	ELEVENLABS_TRANSCRIPTION_MODELS,
	GROQ_MODELS,
	OPENAI_TRANSCRIPTION_MODELS,
	type TranscriptionModel,
} from './models';

export const TRANSCRIPTION_SERVICE_IDS = [
	'OpenAI',
	'Groq',
	'speaches',
	'ElevenLabs',
] as const;

type TranscriptionServiceId = (typeof TRANSCRIPTION_SERVICE_IDS)[number];

type BaseTranscriptionService = {
	id: TranscriptionServiceId;
	name: string;
	icon: unknown;
};

type ApiTranscriptionService = BaseTranscriptionService & {
	type: 'api';
	models: readonly TranscriptionModel[];
	defaultModel: TranscriptionModel;
	modelSettingKey: string;
	apiKeyField: keyof Settings;
};

type ServerTranscriptionService = BaseTranscriptionService & {
	type: 'server';
	serverUrlField: keyof Settings;
};

type SatisfiedTranscriptionService =
	| ApiTranscriptionService
	| ServerTranscriptionService;

export const TRANSCRIPTION_SERVICES = [
	{
		id: 'Groq',
		name: 'Groq Whisper',
		icon: CloudIcon,
		models: GROQ_MODELS,
		defaultModel: GROQ_MODELS[2],
		modelSettingKey: 'transcription.groq.model',
		apiKeyField: 'apiKeys.groq',
		type: 'api',
	},
	{
		id: 'OpenAI',
		name: 'OpenAI Whisper',
		icon: HexagonIcon,
		models: OPENAI_TRANSCRIPTION_MODELS,
		defaultModel: OPENAI_TRANSCRIPTION_MODELS[0],
		modelSettingKey: 'transcription.openai.model',
		apiKeyField: 'apiKeys.openai',
		type: 'api',
	},
	{
		id: 'ElevenLabs',
		name: 'ElevenLabs',
		icon: PauseIcon,
		models: ELEVENLABS_TRANSCRIPTION_MODELS,
		defaultModel: ELEVENLABS_TRANSCRIPTION_MODELS[0],
		modelSettingKey: 'transcription.elevenlabs.model',
		apiKeyField: 'apiKeys.elevenlabs',
		type: 'api',
	},
	{
		id: 'speaches',
		name: 'Speaches',
		icon: ServerIcon,
		serverUrlField: 'transcription.speaches.baseUrl',
		type: 'server',
	},
] as const satisfies SatisfiedTranscriptionService[];

export const TRANSCRIPTION_SERVICE_OPTIONS = TRANSCRIPTION_SERVICES.map(
	(service) => ({
		label: service.name,
		value: service.id,
	}),
);

export type TranscriptionService = (typeof TRANSCRIPTION_SERVICES)[number];
