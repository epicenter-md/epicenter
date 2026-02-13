import { ElevenLabsClient } from 'elevenlabs';
import { Ok, type Result } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import type { Settings } from '$lib/settings';

export const ELEVENLABS_TRANSCRIPTION_MODELS = [
	{
		name: 'scribe_v2',
		description:
			'Latest flagship transcription model with 97% accuracy. Features speaker diarization (up to 48 speakers), entity detection, keyterm prompting, and dynamic audio tagging across 90+ languages.',
		cost: '$0.40/hour',
	},
	{
		name: 'scribe_v1',
		description:
			'Previous generation transcription model with 96.7% accuracy for English. Supports 99 languages with word-level timestamps and speaker diarization.',
		cost: '$0.40/hour',
	},
	{
		name: 'scribe_v1_experimental',
		description:
			'Experimental version of Scribe with latest features and improvements. May include cutting-edge capabilities but with potential instability.',
		cost: '$0.40/hour',
	},
] as const;

export type ElevenLabsModel = (typeof ELEVENLABS_TRANSCRIPTION_MODELS)[number];

export const MAX_FILE_SIZE_MB = 1000 as const; // ElevenLabs allows files up to 1GB

export const ElevenlabsTranscriptionServiceLive = {
	transcribe: async (
		audioBlob: Blob,
		options: {
			prompt: string;
			temperature: string;
			outputLanguage: Settings['transcription.outputLanguage'];
			apiKey: string;
			modelName: (string & {}) | ElevenLabsModel['name'];
		},
	): Promise<Result<string, WhisperingError>> => {
		if (!options.apiKey) {
			return WhisperingErr({
				title: '🔑 API Key Required',
				description:
					'Please enter your ElevenLabs API key in settings to use speech-to-text transcription.',
				action: {
					type: 'link',
					label: 'Add API key',
					href: '/settings/transcription',
				},
			});
		}

		try {
			const client = new ElevenLabsClient({
				apiKey: options.apiKey,
			});

			// Check file size
			const blobSizeInMb = audioBlob.size / (1024 * 1024);

			if (blobSizeInMb > MAX_FILE_SIZE_MB) {
				return WhisperingErr({
					title: '📁 File Size Too Large',
					description: `Your audio file (${blobSizeInMb.toFixed(1)}MB) exceeds the ${MAX_FILE_SIZE_MB}MB limit. Please use a smaller file or compress the audio.`,
				});
			}

			// Use the client's speechToText functionality
			const transcription = await client.speechToText.convert({
				file: audioBlob,
				model_id: options.modelName,
				// Map outputLanguage if not set to 'auto'
				language_code:
					options.outputLanguage !== 'auto'
						? options.outputLanguage
						: undefined,
				tag_audio_events: false,
				diarize: true,
			});

			// Return the transcribed text
			return Ok(transcription.text.trim());
		} catch (error) {
			return WhisperingErr({
				title: '🔧 Transcription Failed',
				description:
					'Unable to complete the transcription using ElevenLabs. This may be due to a service issue or unsupported audio format. Please try again.',
				action: { type: 'more-details', error },
			});
		}
	},
};

export type ElevenLabsTranscriptionService =
	typeof ElevenlabsTranscriptionServiceLive;
