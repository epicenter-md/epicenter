import type { AnyTaggedError } from 'wellcrafted/error';

type LinkActionShape = {
	type: 'link';
	label: string;
	href: `/${string}`;
};

const updateApiKeyAction: LinkActionShape = {
	type: 'link',
	label: 'Update API key',
	href: '/settings/transcription',
};

const addApiKeyAction: LinkActionShape = {
	type: 'link',
	label: 'Add API key',
	href: '/settings/transcription',
};

export const apiKeyRequired = (provider: string) => ({
	title: '🔑 API Key Required',
	description: `Please enter your ${provider} API key in settings.`,
	action: addApiKeyAction,
});

export const invalidApiKeyFormat = (provider: string, prefixes: string) => ({
	title: '🔑 Invalid API Key Format',
	description: `Your ${provider} API key should start with ${prefixes}. Please check and update your API key.`,
	action: updateApiKeyAction,
});

export const fileTooLarge = ({
	sizeMb,
	maxMb,
}: {
	sizeMb: number;
	maxMb: number;
}) => ({
	title: `The file size (${sizeMb.toFixed(1)}MB) is too large`,
	description: `Please upload a file smaller than ${maxMb}MB.`,
});

export const fileCreationFailed = (serviceError: AnyTaggedError) => ({
	title: '📄 File Creation Failed',
	description:
		'Failed to create audio file for transcription. Please try again.',
	serviceError,
});

export const unauthorized = (serviceError: AnyTaggedError) => ({
	title: '🔑 Authentication Required',
	description:
		serviceError.message ||
		'Your API key appears to be invalid or expired. Please update your API key in settings to continue transcribing.',
	action: updateApiKeyAction,
});

export const rateLimit = (serviceError: AnyTaggedError) => ({
	title: '⏱️ Rate Limit Reached',
	description:
		serviceError.message || 'Too many requests. Please try again later.',
	serviceError,
});

export const serviceUnavailable = (
	provider: string,
	serviceError: AnyTaggedError & { status: number },
) => ({
	title: '🔧 Service Unavailable',
	description:
		serviceError.message ||
		`The ${provider} service is temporarily unavailable (Error ${serviceError.status}). Please try again later.`,
	serviceError,
});

export const connectionIssue = (
	provider: string,
	serviceError: AnyTaggedError,
) => ({
	title: '🌐 Connection Issue',
	description:
		serviceError.message ||
		`Unable to connect to the ${provider} service. This could be a network issue or temporary service interruption.`,
	serviceError,
});

export const badRequest = (provider: string, serviceError: AnyTaggedError) => ({
	title: '❌ Bad Request',
	description: serviceError.message || `Invalid request to ${provider} API.`,
	serviceError,
});

export const permissionDenied = (serviceError: AnyTaggedError) => ({
	title: '⛔ Permission Denied',
	description:
		serviceError.message ||
		"Your account doesn't have access to this feature. This may be due to plan limitations or account restrictions.",
	serviceError,
});

export const notFound = (serviceError: AnyTaggedError) => ({
	title: '🔍 Not Found',
	description:
		serviceError.message ||
		'The requested resource was not found. This might indicate an issue with the model or API endpoint.',
	serviceError,
});

export const payloadTooLarge = (serviceError: AnyTaggedError) => ({
	title: '📦 Audio File Too Large',
	description:
		serviceError.message ||
		'Your audio file exceeds the maximum size limit. Try splitting it into smaller segments or reducing the audio quality.',
	serviceError,
});

export const unsupportedMediaType = (serviceError: AnyTaggedError) => ({
	title: '🎵 Unsupported Format',
	description:
		serviceError.message ||
		"This audio format isn't supported. Please convert your file to MP3, WAV, M4A, or another common audio format.",
	serviceError,
});

export const unprocessableEntity = (serviceError: AnyTaggedError) => ({
	title: '⚠️ Invalid Input',
	description:
		serviceError.message ||
		'The request was valid but the server cannot process it. Please check your audio file and parameters.',
	serviceError,
});

export const unexpected = (serviceError: AnyTaggedError) => ({
	title: '❌ Unexpected Error',
	description:
		serviceError.message || 'An unexpected error occurred. Please try again.',
	serviceError,
});
