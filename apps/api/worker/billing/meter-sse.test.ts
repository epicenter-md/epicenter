import { expect, test } from 'bun:test';
import { meterSSE, type StreamedUsage } from './meter-sse.js';

/** Pipe the given text chunks through the meter and return the captured usage. */
async function run(chunks: string[]): Promise<StreamedUsage | null> {
	let captured: StreamedUsage | null = null;
	const meter = meterSSE((u) => {
		captured = u;
	});
	const encoder = new TextEncoder();
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	const reader = source.pipeThrough(meter).getReader();
	while (!(await reader.read()).done) {
		// drain: forwarding is the point, we only assert the captured usage
	}
	return captured;
}

test('OpenAI: usage on the final choices:[] chunk', async () => {
	const usage = await run([
		'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":null}\n\n',
		'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n',
		'data: [DONE]\n\n',
	]);
	expect(usage).toEqual({ inputTokens: 12, outputTokens: 5 });
});

test('Gemini-compat: usage on intermediate chunks, keep the last', async () => {
	const usage = await run([
		'data: {"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n',
		'data: {"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
		'data: [DONE]\n\n',
	]);
	expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
});

test('no usage in the stream yields null (fallback path)', async () => {
	const usage = await run([
		'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n',
		'data: [DONE]\n\n',
	]);
	expect(usage).toBeNull();
});

test('a data frame split across byte chunks still parses', async () => {
	const line =
		'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n';
	const usage = await run([
		line.slice(0, 18),
		line.slice(18, 44),
		line.slice(44),
		'data: [DONE]\n\n',
	]);
	expect(usage).toEqual({ inputTokens: 7, outputTokens: 3 });
});

test('a mid-stream error frame (no usage) yields null', async () => {
	const usage = await run([
		'data: {"choices":[{"delta":{"content":"partial"}}],"usage":null}\n\n',
		'data: {"error":{"message":"upstream exploded","code":"server_error"}}\n\n',
	]);
	expect(usage).toBeNull();
});
