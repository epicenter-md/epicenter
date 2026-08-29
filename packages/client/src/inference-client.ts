/**
 * Bind one resolved connection to the OpenAI-compatible calls it can serve.
 *
 * The three wire functions (`complete`, `transcribe`, `listModels`) each take a
 * {@link ResolvedConnection} because the connection is the swap point (ADR-0050,
 * ADR-0060): every endpoint speaks the same routes off one base URL, so choosing
 * a backend is choosing a URL. Passing that connection to each call is repetitive
 * at a call site that has already resolved it once, so this binds it.
 *
 * It is sugar, deliberately thin: every method forwards to the free function of
 * the same name, and the free functions stay exported for callers that hold a
 * connection only briefly. The client also spreads `fetch` and `baseURL` through,
 * so anything that consumes a bare transport (the agent engine's `data()`) can
 * take a client without unwrapping it.
 */

import type { Result } from 'wellcrafted/result';
import {
	type CompleteError,
	type CompleteOptions,
	complete,
} from './complete.js';
import {
	type ListModelsError,
	listModels,
	type ResolvedConnection,
} from './connection.js';
import {
	type TranscribeError,
	type TranscribeOptions,
	transcribe,
} from './transcribe.js';

/** A connection bound to the calls it serves. Superset of {@link ResolvedConnection}. */
export type InferenceClient = ReturnType<typeof createInferenceClient>;

/**
 * Bind a resolved connection so its routes are callable without repeating it.
 *
 * ```ts
 * const client = createInferenceClient(connections.resolve(model));
 * await client.listModels();
 * await client.transcribe(audio, { model });
 * ```
 */
export function createInferenceClient(resolved: ResolvedConnection) {
	return {
		/** The transport this client is bound to, so a client is usable as a connection. */
		fetch: resolved.fetch,
		/** The base URL every route is appended to. */
		baseURL: resolved.baseURL,

		/** `POST {base}/chat/completions`: one non-streamed completion. */
		complete(options: CompleteOptions): Promise<Result<string, CompleteError>> {
			return complete(resolved, options);
		},

		/** `POST {base}/audio/transcriptions`: multipart audio in, transcript out. */
		transcribe(
			audio: Blob,
			options: TranscribeOptions,
		): Promise<Result<string, TranscribeError>> {
			return transcribe(resolved, audio, options);
		},

		/** `GET {base}/models`: the ids this endpoint serves, for discovery. */
		listModels(): Promise<Result<string[], ListModelsError>> {
			return listModels(resolved);
		},
	};
}
