import { WhisperingErr } from '$lib/result';
import type { OpenaiError } from '$lib/services/transcription/cloud/openai';
import * as shared from './shared';

export function openaiErrorToWhisperingErr(error: OpenaiError) {
	switch (error.name) {
		case 'MissingApiKey':
			return WhisperingErr(shared.apiKeyRequired('OpenAI'));
		case 'InvalidApiKeyFormat':
			return WhisperingErr(shared.invalidApiKeyFormat('OpenAI', '"sk-"'));
		case 'FileTooLarge':
			return WhisperingErr(shared.fileTooLarge(error));
		case 'FileCreationFailed':
			return WhisperingErr(shared.fileCreationFailed(error));
		case 'BadRequest':
			return WhisperingErr(shared.badRequest('OpenAI', error));
		case 'Unauthorized':
			return WhisperingErr(shared.unauthorized(error));
		case 'PermissionDenied':
			return WhisperingErr(shared.permissionDenied(error));
		case 'NotFound':
			return WhisperingErr(shared.notFound(error));
		case 'PayloadTooLarge':
			return WhisperingErr(shared.payloadTooLarge(error));
		case 'UnsupportedMediaType':
			return WhisperingErr(shared.unsupportedMediaType(error));
		case 'UnprocessableEntity':
			return WhisperingErr(shared.unprocessableEntity(error));
		case 'RateLimit':
			return WhisperingErr(shared.rateLimit(error));
		case 'ServiceUnavailable':
			return WhisperingErr(shared.serviceUnavailable('OpenAI', error));
		case 'Connection':
			return WhisperingErr(shared.connectionIssue('OpenAI', error));
		case 'Unexpected':
			return WhisperingErr(shared.unexpected(error));
	}
}
