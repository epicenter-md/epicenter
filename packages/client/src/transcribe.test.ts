import { afterEach, describe, expect, test } from 'bun:test';
import { resolveConnection } from './connection.js';
import { transcribe } from './transcribe.js';

describe('transcribe over the OpenAI wire', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function captureRequest(response: Response) {
		const seen: { url: string; init: RequestInit | undefined }[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			seen.push({ url: String(url), init });
			return response;
		}) as unknown as typeof fetch;
		return seen;
	}

	test('posts multipart to /v1/audio/transcriptions and returns trimmed text', async () => {
		const seen = captureRequest(
			new Response(JSON.stringify({ text: '  hello world  ' }), {
				status: 200,
			}),
		);

		const { data, error } = await transcribe(
			resolveConnection({ baseUrl: 'http://localhost:8000/v1' }),
			new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
			{ model: 'whisper-1' },
		);

		expect(error).toBeNull();
		expect(data).toBe('hello world');
		expect(seen).toHaveLength(1);
		// The connection's baseUrl already carries `/v1`; the client appends the
		// rest of the wire path, like the sibling chat client does.
		expect(seen[0]?.url).toBe('http://localhost:8000/v1/audio/transcriptions');
		expect(seen[0]?.init?.method).toBe('POST');

		const form = seen[0]?.init?.body as FormData;
		expect(form.get('model')).toBe('whisper-1');
		const file = form.get('file') as File;
		// The extension is derived from the blob MIME so the wire detects the format.
		expect(file.name).toBe('audio.webm');
	});

	test('forwards through the resolved transport: a keyed connection sends a Bearer', async () => {
		const seen = captureRequest(
			new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
		);

		// The Bearer is `resolveConnection`'s contract, not transcribe's: transcribe
		// just POSTs through whatever transport it is handed. This proves the
		// composition callers use (resolve a connection, then transcribe).
		await transcribe(
			resolveConnection({
				baseUrl: 'https://api.groq.com/openai/v1',
				apiKey: 'sk-test',
			}),
			new Blob([new Uint8Array([1])], { type: 'audio/mp4' }),
			{ model: 'whisper-large-v3', language: 'en', prompt: 'Epicenter' },
		);

		const headers = new Headers(seen[0]?.init?.headers);
		expect(headers.get('Authorization')).toBe('Bearer sk-test');
		const form = seen[0]?.init?.body as FormData;
		expect(form.get('language')).toBe('en');
		expect(form.get('prompt')).toBe('Epicenter');
	});

	test('a non-2xx becomes a RequestFailed carrying the status', async () => {
		captureRequest(new Response('nope', { status: 401 }));

		const { data, error } = await transcribe(
			resolveConnection({
				baseUrl: 'https://api.openai.com/v1',
				apiKey: 'bad',
			}),
			new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
			{ model: 'whisper-1' },
		);

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(401);
			expect(error.detail).toBe('nope');
		}
	});

	test('a 2xx body that is not { text } becomes Malformed', async () => {
		captureRequest(
			new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
		);

		const { data, error } = await transcribe(
			resolveConnection({ baseUrl: 'http://localhost:8000/v1' }),
			new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
			{ model: 'whisper-1' },
		);

		expect(data).toBeNull();
		expect(error?.name).toBe('Malformed');
	});

	// The upload filename's extension is how the OpenAI wire detects the audio
	// format, so the closed MIME->extension allowlist must map each recorder MIME
	// to an extension the wire accepts, never a raw subtype slice (`audio/wave`
	// would slice to the rejected `wave`, `audio/mpeg` to `mpeg` not `mp3`).
	const filenameCases: [mime: string, expected: string][] = [
		['audio/wave', 'audio.wav'], // not 'audio.wave'
		['audio/x-wav', 'audio.wav'],
		['audio/mpeg', 'audio.mp3'], // not 'audio.mpeg'
		['audio/webm;codecs=opus', 'audio.webm'], // the codec parameter is stripped
		['audio/x-m4a', 'audio.m4a'],
		['audio/ogg', 'audio.ogg'],
		['', 'audio.mp3'], // a missing type falls back to mp3
		['application/octet-stream', 'audio.mp3'], // an unknown type falls back to mp3
	];

	for (const [mime, expected] of filenameCases) {
		test(`maps blob MIME "${mime || '(none)'}" to upload filename ${expected}`, async () => {
			const seen = captureRequest(
				new Response(JSON.stringify({ text: 'x' }), { status: 200 }),
			);

			await transcribe(
				resolveConnection({ baseUrl: 'http://localhost:8000/v1' }),
				new Blob([new Uint8Array([1])], { type: mime }),
				{ model: 'whisper-1' },
			);

			const form = seen[0]?.init?.body as FormData;
			expect((form.get('file') as File).name).toBe(expected);
		});
	}
});
