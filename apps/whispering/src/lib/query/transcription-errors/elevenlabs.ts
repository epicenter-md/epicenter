import { WhisperingErr } from '$lib/result';
import type { ElevenLabsError } from '$lib/services/transcription/cloud/elevenlabs';
import * as shared from './shared';

export function elevenlabsErrorToWhisperingErr(error: ElevenLabsError) {
	switch (error.name) {
		case 'MissingApiKey':
			return WhisperingErr(shared.apiKeyRequired('ElevenLabs'));
		case 'FileTooLarge':
			return WhisperingErr(shared.fileTooLarge(error));
		case 'Unexpected':
			return WhisperingErr({
				title: '🔧 Transcription Failed',
				description:
					'Unable to complete the transcription using ElevenLabs. This may be due to a service issue or unsupported audio format. Please try again.',
				serviceError: error,
			});
	}
}
