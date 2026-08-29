/**
 * `complete`: the one OpenAI-compatible non-streaming chat-completion client
 * (ADR-0050/0060). The single-shot sibling of `transcribe` and of the streaming
 * `createOpenAiAgentEngine`: one `POST {baseURL}/chat/completions` with a system
 * and a user message, returning the assistant's text.
 *
 * Like `transcribe`, `listModels`, and the agent engine, this consumes the
 * *resolved* transport (`{ fetch, baseURL }`, see {@link ResolvedConnection}), not
 * a static `Connection`. `resolveConnection` is the single boundary the caller
 * crosses, so OpenAI, Groq, OpenRouter, and a custom OpenAI-compatible server are
 * not four code paths; they are four connections handed to the same function.
 *
 * This is the refine engine's prompt step generalized off the `openai` SDK: it
 * holds no provider knowledge and no key. A provider that does not speak this wire
 * (Anthropic, which requires `max_tokens` and returns content blocks; Google, which
 * takes one combined prompt) keeps its own bespoke client, exactly as Deepgram and
 * ElevenLabs do for transcription (ADR-0060 blesses that exception). The error stays
 * lean and structured (it carries the HTTP `status`); an app maps a status to its
 * own copy at its toast layer.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { joinUrl, type ResolvedConnection } from './connection.js';

/**
 * One non-streaming completion: the model to ask, plus a system and a user
 * message. The two prompts are sent as the OpenAI `system` and `user` roles; an
 * empty string is still sent (the wire accepts it), matching the prior behavior.
 */
export type CompleteOptions = {
	model: string;
	systemPrompt: string;
	userPrompt: string;
	/**
	 * Aborts the in-flight request when it fires. A completion is one request, so
	 * the signal is a per-call option (it sits next to `model` and the prompts),
	 * not a property of the connection; it is forwarded into the underlying
	 * request so the HTTP call is genuinely cancelled, not just abandoned.
	 */
	signal?: AbortSignal;
};

export const CompleteError = defineErrors({
	/** The transport itself failed: network down, DNS, aborted, CORS. */
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the completion endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The request reached a server but returned a non-2xx status. `status` and
	 * `detail` are carried so a consumer can branch (401 -> bad key) and surface
	 * its own copy.
	 */
	RequestFailed: ({ status, detail }: { status: number; detail?: string }) => ({
		message: `Completion failed (${status})${detail ? `: ${detail}` : ''}`,
		status,
		detail,
	}),
	/**
	 * A 2xx body that was not an OpenAI `{ choices: [{ message: { content } }] }`
	 * shape, or carried no text content.
	 */
	Malformed: () => ({
		message:
			'The completion response had no OpenAI { choices: [{ message: { content } }] } text.',
	}),
});
export type CompleteError = InferErrors<typeof CompleteError>;

/**
 * Run one non-streaming chat completion over the OpenAI wire. Takes the resolved
 * transport (`{ fetch, baseURL }`), POSTs a system and a user message, and returns
 * the assistant's text or a typed {@link CompleteError}. Never throws.
 */
export async function complete(
	{ fetch, baseURL }: ResolvedConnection,
	{ model, systemPrompt, userPrompt, signal }: CompleteOptions,
): Promise<Result<string, CompleteError>> {
	const { data: response, error: transportError } = await tryAsync({
		try: () =>
			fetch(joinUrl(baseURL, 'chat/completions'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					stream: false,
				}),
				signal,
			}),
		catch: (cause) => CompleteError.TransportFailed({ cause }),
	});
	if (transportError) return Err(transportError);

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return CompleteError.RequestFailed({ status: response.status, detail });
	}

	const { data: body, error: parseError } = await tryAsync({
		try: () => response.json() as Promise<unknown>,
		catch: () => CompleteError.Malformed(),
	});
	if (parseError) return Err(parseError);

	const content = extractContent(body);
	if (!content) return CompleteError.Malformed();
	return Ok(content);
}

/**
 * Pull the first choice's message content out of an OpenAI
 * `{ choices: [{ message: { content: string } }] }` body, or null if the shape is
 * wrong or the content is empty.
 */
function extractContent(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || !('choices' in body))
		return null;
	const { choices } = body as { choices: unknown };
	if (!Array.isArray(choices)) return null;
	const message = (choices[0] as { message?: unknown } | undefined)?.message;
	if (
		typeof message !== 'object' ||
		message === null ||
		!('content' in message)
	)
		return null;
	const { content } = message as { content: unknown };
	return typeof content === 'string' && content.length > 0 ? content : null;
}
