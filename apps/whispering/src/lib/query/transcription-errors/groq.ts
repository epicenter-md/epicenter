import { WhisperingErr } from '$lib/result';
import type { GroqError } from '$lib/services/transcription/cloud/groq';
import * as shared from './shared';

export function groqErrorToWhisperingErr(error: GroqError) {
	switch (error.name) {
		case 'MissingApiKey':
			return WhisperingErr(shared.apiKeyRequired('Groq'));
		case 'InvalidApiKeyFormat':
			return WhisperingErr(
				shared.invalidApiKeyFormat('Groq', '"gsk_" or "xai-"'),
			);
		case 'FileTooLarge':
			return WhisperingErr(shared.fileTooLarge(error));
		case 'FileCreationFailed':
			return WhisperingErr(shared.fileCreationFailed(error));
		case 'BadRequest':
			return WhisperingErr(shared.badRequest('Groq', error));
		case 'Unauthorized':
			return WhisperingErr(shared.unauthorized(error));
		case 'PermissionDenied':
			return WhisperingErr(shared.permissionDenied(error));
		case 'NotFound':
			return WhisperingErr(shared.notFound(error));
		case 'UnprocessableEntity':
			return WhisperingErr(shared.unprocessableEntity(error));
		case 'RateLimit':
			return WhisperingErr(shared.rateLimit(error));
		case 'ServiceUnavailable':
			return WhisperingErr(shared.serviceUnavailable('Groq', error));
		case 'Connection':
			return WhisperingErr(shared.connectionIssue('Groq', error));
		case 'Unexpected':
			return WhisperingErr(shared.unexpected(error));
	}
}
