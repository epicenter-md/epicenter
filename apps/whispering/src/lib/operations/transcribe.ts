import { stat } from '@tauri-apps/plugin-fs';
import { type AnyTaggedError, defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLanguage,
} from '$lib/constants/languages';
import {
	isModelFileSizeValid,
	WHISPER_MODELS,
} from '$lib/constants/local-models';
import type { TranscriptionServiceId } from '$lib/constants/transcription';
import { analytics } from '$lib/operations/analytics';
import { report } from '$lib/report';
import { services } from '$lib/services';
import {
	LocalPreflightError,
	requireExistingModelPath,
} from '$lib/services/transcription/local-preflight';
import { TRANSCRIPTION_SERVICES } from '$lib/services/transcription/registry';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import { tauri } from '$lib/tauri';
import { commands } from '$lib/tauri/commands';

export type TranscriptionError = AnyTaggedError;

const TranscriptionOperationError = defineErrors({
	NoTranscriptionServiceSelected: () => ({
		message: 'Please select a transcription service in settings.',
	}),
	LocalTranscriptionUnavailableOnWeb: () => ({
		message:
			'Local transcription is only available in the desktop app. Choose a cloud or self-hosted provider on web.',
	}),
});

/**
 * Services that upload audio bytes to a remote endpoint. Local engines read
 * the recording artifact from disk via the Rust `transcribe_recording`
 * command.
 */
function isUploadTranscriptionService(
	serviceId: TranscriptionServiceId,
): boolean {
	const entry = TRANSCRIPTION_SERVICES.find((s) => s.id === serviceId);
	return entry?.location === 'cloud' || entry?.location === 'self-hosted';
}

function getOutputLanguage(): SupportedLanguage {
	const language = settings.get('transcription.language');
	for (const supportedLanguage of SUPPORTED_LANGUAGES) {
		if (supportedLanguage === language) {
			return supportedLanguage;
		}
	}
	return 'auto';
}

/**
 * Materialize the bytes to upload for a cloud transcription. The recording
 * is already saved under `recordings/{id}.{ext}`; in Tauri we round-trip
 * through Rust's libopus to land on a compressed opus blob. On the web
 * there is no Rust, so we fetch the original bytes from the blob store and
 * upload them as-is.
 */
async function loadForCloudUpload(
	recordingId: string,
): Promise<Result<Blob, TranscriptionError>> {
	if (tauri) {
		const { data: oggBytes, error } =
			await commands.encodeRecordingForUpload(recordingId);
		if (error === null) return Ok(new Blob([oggBytes], { type: 'audio/ogg' }));
		report.info({
			title: 'Audio compression skipped',
			description: `${error}. Uploading uncompressed audio instead.`,
		});
		analytics.logEvent({
			type: 'compression_failed',
			provider: settings.get('transcription.service'),
			error_message: error,
		});
	}

	return services.blobs.audio.getBlob(recordingId);
}

/**
 * Transcribe a saved recording by id. This is the single canonical entry
 * point for transcription:
 *
 * - The cpal stop path saves the WAV via Rust and returns the id.
 * - The navigator / VAD / file-upload paths save the blob via the
 *   recordings blob store and pass the id here.
 *
 * Local transcription always goes through `transcribe_recording(id)`.
 * Cloud transcription uploads compressed bytes derived from the saved file
 * when possible, falling back to the raw blob.
 */
export async function transcribeAudio(
	recordingId: string,
): Promise<Result<string, TranscriptionError>> {
	const selectedService = settings.get('transcription.service');

	const startTime = Date.now();
	analytics.logEvent({
		type: 'transcription_requested',
		provider: selectedService,
	});

	const transcriptionResult = isUploadTranscriptionService(selectedService)
		? await dispatchCloudTranscription(recordingId, selectedService)
		: await dispatchLocalTranscription(recordingId, selectedService);

	const duration = Date.now() - startTime;
	if (transcriptionResult.error) {
		analytics.logEvent({
			type: 'transcription_failed',
			provider: selectedService,
			error_name: transcriptionResult.error.name,
			error_message: transcriptionResult.error.message,
		});
	} else {
		analytics.logEvent({
			type: 'transcription_completed',
			provider: selectedService,
			duration,
		});
	}

	return transcriptionResult;
}

/**
 * Per-engine FE preflight metadata. Each local engine validates the same
 * way (path exists + is the expected `kind`); whispercpp adds a truncated-
 * download check because corrupted .bin files load successfully but produce
 * garbage transcripts. Putting it in a table makes the per-engine data
 * legible in one place; the dispatch loop stays linear.
 *
 * Moonshine directory-name validation lives in Rust
 * (`parse_moonshine_variant`) since the wire format is the loader's concern.
 */
const LOCAL_ENGINE_PREFLIGHT = {
	whispercpp: {
		kind: 'file',
		displayName: 'Whisper C++',
		modelPathKey: 'transcription.whispercpp.modelPath',
	},
	parakeet: {
		kind: 'directory',
		displayName: 'Parakeet',
		modelPathKey: 'transcription.parakeet.modelPath',
	},
	moonshine: {
		kind: 'directory',
		displayName: 'Moonshine',
		modelPathKey: 'transcription.moonshine.modelPath',
	},
} as const satisfies Record<
	'whispercpp' | 'parakeet' | 'moonshine',
	{
		kind: 'file' | 'directory';
		displayName: string;
		modelPathKey:
			| 'transcription.whispercpp.modelPath'
			| 'transcription.parakeet.modelPath'
			| 'transcription.moonshine.modelPath';
	}
>;

type LocalEngineId = keyof typeof LOCAL_ENGINE_PREFLIGHT;

function isLocalEngineId(id: TranscriptionServiceId): id is LocalEngineId {
	return id in LOCAL_ENGINE_PREFLIGHT;
}

/**
 * Whisper .bin downloads can finish at a smaller-than-expected size when the
 * connection drops mid-stream. The file still loads via whisper.cpp but
 * produces nonsense transcripts. Catalog match is best-effort: only models
 * we recognize from `WHISPER_MODELS` have an expected size to compare.
 */
async function checkWhisperTruncation(
	modelPath: string,
): Promise<Result<void, LocalPreflightError>> {
	const modelConfig = WHISPER_MODELS.find((m) =>
		modelPath.endsWith(m.file.filename),
	);
	if (!modelConfig) return Ok(undefined);

	const { data: fileStats } = await tryAsync({
		try: () => stat(modelPath),
		catch: () => Ok(null),
	});
	if (!fileStats) return Ok(undefined);

	if (!isModelFileSizeValid(fileStats.size, modelConfig.sizeBytes)) {
		return LocalPreflightError.CorruptedModelFile({
			actualSizeMb: Math.round(fileStats.size / 1000000),
			expectedSizeMb: Math.round(modelConfig.sizeBytes / 1000000),
		});
	}
	return Ok(undefined);
}

async function dispatchLocalTranscription(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	if (!tauri) {
		return TranscriptionOperationError.LocalTranscriptionUnavailableOnWeb();
	}

	if (!isLocalEngineId(selectedService)) {
		return TranscriptionOperationError.NoTranscriptionServiceSelected();
	}

	// FE preflight: Rust would also fail via `ModelLoadError`, but the FE
	// owns better UX strings (per-engine display name, file-vs-directory
	// guidance) and can short-circuit before the IPC round-trip.
	const { kind, displayName, modelPathKey } =
		LOCAL_ENGINE_PREFLIGHT[selectedService];
	const modelPath = deviceConfig.get(modelPathKey);

	const validation = await requireExistingModelPath(
		modelPath,
		kind,
		displayName,
	);
	if (validation.error) return validation;

	if (selectedService === 'whispercpp') {
		const truncated = await checkWhisperTruncation(modelPath);
		if (truncated.error) return truncated;
	}

	// Rust reads engine, modelPath, language, prompt, and unloadPolicy from
	// the ambient config pushed via `setTranscriptionConfig` in the layout
	// effect. Anything that affects inference output is already there.
	return commands.transcribeRecording(recordingId);
}

async function dispatchCloudTranscription(
	recordingId: string,
	selectedService: TranscriptionServiceId,
): Promise<Result<string, TranscriptionError>> {
	const { data: audio, error: loadError } =
		await loadForCloudUpload(recordingId);
	if (loadError) return Err(loadError);

	const outputLanguage = getOutputLanguage();
	const prompt = settings.get('transcription.prompt');

	switch (selectedService) {
		case 'OpenAI': {
			return services.transcriptions.openai.transcribe(audio, {
				outputLanguage,
				prompt,
				apiKey: deviceConfig.get('apiKeys.openai'),
				modelName: settings.get('transcription.openai.model'),
				baseURL: deviceConfig.get('apiEndpoints.openai') || undefined,
			});
		}
		case 'Groq': {
			return services.transcriptions.groq.transcribe(audio, {
				outputLanguage,
				prompt,
				apiKey: deviceConfig.get('apiKeys.groq'),
				modelName: settings.get('transcription.groq.model'),
				baseURL: deviceConfig.get('apiEndpoints.groq') || undefined,
			});
		}
		case 'speaches': {
			return services.transcriptions.speaches.transcribe(audio, {
				outputLanguage,
				prompt,
				modelId: deviceConfig.get('transcription.speaches.modelId'),
				baseUrl: deviceConfig.get('transcription.speaches.baseUrl'),
			});
		}
		case 'ElevenLabs': {
			return services.transcriptions.elevenlabs.transcribe(audio, {
				outputLanguage,
				prompt,
				apiKey: deviceConfig.get('apiKeys.elevenlabs'),
				modelName: settings.get('transcription.elevenlabs.model'),
			});
		}
		case 'Deepgram': {
			return services.transcriptions.deepgram.transcribe(audio, {
				outputLanguage,
				prompt,
				apiKey: deviceConfig.get('apiKeys.deepgram'),
				modelName: settings.get('transcription.deepgram.model'),
			});
		}
		case 'Mistral': {
			return services.transcriptions.mistral.transcribe(audio, {
				outputLanguage,
				prompt,
				apiKey: deviceConfig.get('apiKeys.mistral'),
				modelName: settings.get('transcription.mistral.model'),
			});
		}
		default:
			return TranscriptionOperationError.NoTranscriptionServiceSelected();
	}
}
