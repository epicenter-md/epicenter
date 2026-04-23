import { WhisperingErr } from '$lib/result';
import type { DeepgramError } from '$lib/services/transcription/cloud/deepgram';
import * as shared from './shared';

export function deepgramErrorToWhisperingErr(error: DeepgramError) {
	switch (error.name) {
		case 'MissingApiKey':
			return WhisperingErr(shared.apiKeyRequired('Deepgram'));
		case 'FileTooLarge':
			return WhisperingErr(shared.fileTooLarge(error));
		case 'Connection':
			return WhisperingErr(shared.connectionIssue('Deepgram', error));
		case 'BadRequest':
			return WhisperingErr(shared.badRequest('Deepgram', error));
		case 'Unauthorized':
			return WhisperingErr(shared.unauthorized(error));
		case 'Forbidden':
			return WhisperingErr(shared.permissionDenied(error));
		case 'PayloadTooLarge':
			return WhisperingErr(shared.payloadTooLarge(error));
		case 'UnsupportedMediaType':
			return WhisperingErr(shared.unsupportedMediaType(error));
		case 'RateLimit':
			return WhisperingErr(shared.rateLimit(error));
		case 'ServiceUnavailable':
			return WhisperingErr(shared.serviceUnavailable('Deepgram', error));
		case 'Parse':
			return WhisperingErr({
				title: '🔍 Response Error',
				description:
					'Received an unexpected response from Deepgram service. Please try again.',
				serviceError: error,
			});
		case 'NoTranscriptDetected':
			return WhisperingErr({
				title: '📝 No Transcription Found',
				description:
					'No speech was detected in the audio file. Please check your audio and try again.',
			});
		case 'Unexpected':
			return WhisperingErr(shared.unexpected(error));
	}
}
