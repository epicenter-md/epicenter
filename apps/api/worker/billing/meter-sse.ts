/**
 * Tee an OpenAI-compatible SSE chat stream: forward every byte to the client
 * unchanged while capturing the token-usage line, so the meter can settle on the
 * provider's actual usage after the stream drains.
 *
 * Grounded in the streaming research (2026-08-26):
 *   - Standard `TransformStream` (compat date >= 2024-12-16, on here): enqueue the
 *     chunk first so the client sees bytes immediately with natural backpressure,
 *     then inspect a copy. `flush()` fires once at clean stream end.
 *   - SSE frames split across reads and a UTF-8 codepoint can split mid-byte, so
 *     decode with `{ stream: true }`, buffer, and only cut complete `\n` lines.
 *   - Keep the LAST line carrying a populated `usage` object, never accumulate:
 *     OpenAI emits usage once on a trailing `choices: []` chunk; Gemini's compat
 *     endpoint may emit it on intermediate chunks too. Both normalize to the same
 *     `prompt_tokens` / `completion_tokens` fields.
 *   - `[DONE]` and empty keepalive lines carry no usage.
 * Client abort is handled by the caller (flush never fires on cancel); this only
 * reports what a cleanly-drained stream contained.
 */

export type StreamedUsage = { inputTokens: number; outputTokens: number };

/** Matches a `data:` payload that carries a populated (non-null) usage object. */
const POPULATED_USAGE = /"usage"\s*:\s*\{/;

/**
 * Build the pass-through TransformStream. `onUsage` is invoked exactly once from
 * `flush()` with the parsed usage, or `null` when the drained stream carried none
 * (a mid-stream error frame instead of a usage chunk).
 */
export function meterSSE(
	onUsage: (usage: StreamedUsage | null) => void,
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = '';
	let lastUsageLine: string | null = null;

	return new TransformStream({
		transform(chunk, controller) {
			// Forward first: the client sees bytes now, unchanged.
			controller.enqueue(chunk);

			buffer += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).trimEnd();
				buffer = buffer.slice(newline + 1);
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '' || payload === '[DONE]') continue;
				// Cheap per-line check; the single JSON.parse is deferred to flush.
				if (POPULATED_USAGE.test(payload)) lastUsageLine = payload;
			}
		},
		flush() {
			buffer += decoder.decode();
			onUsage(parseUsage(lastUsageLine));
		},
	});
}

function parseUsage(data: string | null): StreamedUsage | null {
	if (!data) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const usage = (parsed as { usage?: unknown }).usage;
	if (!usage || typeof usage !== 'object') return null;
	const input = (usage as { prompt_tokens?: unknown }).prompt_tokens;
	const output = (usage as { completion_tokens?: unknown }).completion_tokens;
	if (typeof input !== 'number' || typeof output !== 'number') return null;
	return { inputTokens: input, outputTokens: output };
}
