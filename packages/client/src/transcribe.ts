/**
 * `transcribe`: the one OpenAI-compatible speech-to-text client (ADR-0050/0056/0060).
 *
 * Transcription is a service: it holds nothing and sees only the audio blob you
 * hand it. So there is one wire (`POST {baseURL}/audio/transcriptions`, multipart
 * `file`, where the connection's `baseURL` already carries `/v1`) reached through
 * the same {@link ResolvedConnection} transport that drives chat, and zero
 * per-provider adapters. OpenAI, Groq, and a self-hosted Speaches box are not three
 * code paths; they are three connections, each `resolveConnection`d to a transport
 * and handed to the same function.
 *
 * Like `listModels` and the chat engine, this consumes the *resolved* transport
 * (`{ fetch, baseURL }`), not the static `Connection`.
 * `resolveConnection` is the single boundary that turns connection data into a
 * transport, and the caller crosses it: a third-party connection resolves its own
 * key into a Bearer, and the hosted Epicenter path injects its audience-scoped
 * session fetch (ADR-0053/0060), which is never connection data. So this client
 * never re-resolves and never branches on what kind of transport it got.
 *
 * Deepgram and ElevenLabs stay bespoke in their own clients: they do not speak
 * this wire (Deepgram takes a raw body under `Authorization: Token`, ElevenLabs an
 * `xi-api-key` with `model_id`), and ADR-0060 blesses that exception. Whispering's
 * in-process `transcribe-rs` engine also stays its own path: it is `invoke` over
 * the Tauri FFI, a privileged non-wire sibling, not a `Connection`.
 *
 * This is `apps/whispering/.../self-hosted/speaches.ts` generalized: the name
 * dropped and the bespoke config replaced by a transport. The error stays lean
 * and structured (it carries the HTTP `status`); an app maps a status to its own
 * user-facing copy at its toast/query layer, the library does not own that copy.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { joinUrl, type ResolvedConnection } from './connection.js';

/**
 * The transcription request, minus the audio and the connection. `model` is
 * required because the wire never defaults it; `language` (an ISO-639-1 hint) and
 * `prompt` (a vocabulary/style hint) are optional, omitted from the form when
 * absent so a server's own defaults apply.
 */
type TranscribeOptions = {
	model: string;
	language?: string;
	prompt?: string;
};

export const TranscribeError = defineErrors({
	/** The transport itself failed: network down, DNS, aborted, CORS, an FFI throw. */
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the transcription endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The request reached a server but returned a non-2xx status. `status` and
	 * `detail` are carried so a consumer can branch (401 -> bad key, 413 -> too
	 * large) and surface its own copy.
	 */
	RequestFailed: ({ status, detail }: { status: number; detail?: string }) => ({
		message: `Transcription failed (${status})${detail ? `: ${detail}` : ''}`,
		status,
		detail,
	}),
	/** A 2xx body that was not the OpenAI `{ text: string }` shape. */
	Malformed: () => ({
		message: 'The transcription response was not an OpenAI { text } body.',
	}),
	/**
	 * No connection on this device serves the requested model, so nothing was sent.
	 * Constructed by callers that resolve a transport before calling
	 * {@link transcribe}, never returned by `transcribe` itself: it is the honest
	 * alternative to inventing a status for a request that never happened. Carries
	 * the model so the surface can name what to configure.
	 */
	NoConnection: ({ model }: { model: string }) => ({
		message: `No connection on this device serves ${model}. Add an inference connection that does.`,
		model,
	}),
});
export type TranscribeError = InferErrors<typeof TranscribeError>;

/**
 * Transcribe an audio blob over the OpenAI wire. Takes the resolved transport
 * (`{ fetch, baseURL }`, see {@link ResolvedConnection}), POSTs a multipart form,
 * and returns the trimmed transcript text or a typed {@link TranscribeError}.
 * Never throws.
 *
 * The blob is sent under a filename whose extension is derived from its MIME type,
 * because the wire detects the audio format from that extension; see
 * {@link filenameForAudio}.
 */
export async function transcribe(
	audio: Blob,
	{ fetch, baseURL }: ResolvedConnection,
	{ model, language, prompt }: TranscribeOptions,
): Promise<Result<string, TranscribeError>> {
	const form = new FormData();
	form.append(
		'file',
		new File([audio], filenameForAudio(audio), {
			type: audio.type || 'audio/wav',
		}),
	);
	form.append('model', model);
	if (language) form.append('language', language);
	if (prompt) form.append('prompt', prompt);

	const { data: response, error: transportError } = await tryAsync({
		try: () =>
			fetch(joinUrl(baseURL, 'audio/transcriptions'), {
				method: 'POST',
				body: form,
			}),
		catch: (cause) => TranscribeError.TransportFailed({ cause }),
	});
	if (transportError) return Err(transportError);

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return TranscribeError.RequestFailed({ status: response.status, detail });
	}

	const { data: body, error: parseError } = await tryAsync({
		try: () => response.json() as Promise<unknown>,
		catch: () => TranscribeError.Malformed(),
	});
	if (parseError) return Err(parseError);

	const text = extractText(body);
	if (text === null) return TranscribeError.Malformed();
	return Ok(text.trim());
}

/**
 * The OpenAI transcription wire accepts a closed set of audio extensions
 * (flac/mp3/mp4/mpeg/mpga/m4a/ogg/opus/wav/webm) and detects the format from the
 * upload filename. So map a recorder blob's MIME to one of those explicitly. A
 * closed allowlist can't manufacture an extension the wire rejects, which a
 * subtype slice would: `audio/wave` slices to the unaccepted `wave`, `audio/mpeg`
 * to `mpeg` rather than `mp3`. Deliberately a literal map, not the `mime` package:
 * the set is tiny and closed, so a dependency that knows thousands of types (and
 * returns `weba`/`oga` you would have to remap anyway) is the wrong primitive for
 * the floor.
 */
const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
	'audio/flac': 'flac',
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'mp4',
	'audio/m4a': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/ogg': 'ogg',
	'audio/opus': 'opus',
	'audio/wav': 'wav',
	'audio/wave': 'wav',
	'audio/x-wav': 'wav',
	'audio/webm': 'webm',
};

/**
 * Derive an upload filename from a blob's MIME type via the closed
 * {@link AUDIO_EXTENSION_BY_MIME} allowlist (the `;codecs=...` parameter is
 * stripped first). `mp3` is the fallback for an unknown or missing type, the
 * format every STT wire auto-detects from the bytes.
 */
function filenameForAudio(audio: Blob): string {
	const mime = audio.type.split(';')[0]?.trim().toLowerCase() ?? '';
	return `audio.${AUDIO_EXTENSION_BY_MIME[mime] ?? 'mp3'}`;
}

/** Pull `text` out of an OpenAI `{ text: string }` body, or null if the shape is wrong. */
function extractText(body: unknown): string | null {
	if (
		typeof body === 'object' &&
		body !== null &&
		'text' in body &&
		typeof (body as { text: unknown }).text === 'string'
	)
		return (body as { text: string }).text;
	return null;
}
