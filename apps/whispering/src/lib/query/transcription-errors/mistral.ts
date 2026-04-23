import { WhisperingErr } from '$lib/result';
import type { MistralTranscriptionError } from '$lib/services/transcription/cloud/mistral';
import * as shared from './shared';

export function mistralErrorToWhisperingErr(error: MistralTranscriptionError) {
	switch (error.name) {
		case 'MissingApiKey':
			return WhisperingErr(shared.apiKeyRequired('Mistral'));
		case 'FileTooLarge':
			return WhisperingErr(shared.fileTooLarge(error));
		case 'FileCreationFailed':
			return WhisperingErr(shared.fileCreationFailed(error));
		case 'Unauthorized':
			return WhisperingErr(shared.unauthorized(error));
		case 'RateLimit':
			return WhisperingErr(shared.rateLimit(error));
		case 'PayloadTooLarge':
			return WhisperingErr(shared.payloadTooLarge(error));
		case 'BadRequest':
			return WhisperingErr(shared.badRequest('Mistral', error));
		case 'ServiceUnavailable':
			return WhisperingErr(shared.serviceUnavailable('Mistral', error));
		case 'Connection':
			return WhisperingErr(shared.connectionIssue('Mistral', error));
		case 'InvalidResponse':
			return WhisperingErr({
				title: '❌ Invalid Transcription Response',
				description: 'Mistral API returned an invalid response format.',
			});
		case 'Unexpected':
			return WhisperingErr(shared.unexpected(error));
	}
}
