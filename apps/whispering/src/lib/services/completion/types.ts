import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const CompletionError = defineErrors({
	/** HTTP-level failure from the provider API. Status preserved for callers that need it. */
	Http: ({ status, cause }: { status: number; cause: unknown }) => ({
		message: `Request failed (${status}): ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	/** Network/DNS/TLS failure: never reached the server */
	ConnectionFailed: ({ cause }: { cause: unknown }) => ({
		message: `Connection failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Provider returned a successful response with no usable content */
	EmptyResponse: ({ providerLabel }: { providerLabel: string }) => ({
		message: `${providerLabel} API returned an empty response`,
		providerLabel,
	}),
	/** Required parameter was not provided */
	MissingParam: ({ param }: { param: string }) => ({
		message: `${param} is required`,
		param,
	}),
});
export type CompletionError = InferErrors<typeof CompletionError>;

export type CompletionService = {
	complete: (opts: {
		apiKey: string;
		model: string;
		systemPrompt: string;
		userPrompt: string;
		/** Optional base URL for custom/self-hosted endpoints (Ollama, LM Studio, etc.) */
		baseUrl?: string;
	}) => Promise<Result<string, CompletionError>>;
};
