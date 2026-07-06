/**
 * Super Chat Server Tests
 *
 * Verifies the loopback shell around one host session (ADR-0084): the
 * per-launch token gates every HTTP request and WebSocket upgrade, the SPA is
 * one self-contained document served byte-for-byte at `/`, and the WebSocket
 * drives the single shared chat session.
 *
 * Key behaviors:
 * - Every route 401s without the token (bearer header or `?token=` query)
 * - `/` returns exactly the page string the server was constructed with
 * - The real vite build emits one document with no external asset references
 * - The spawned `main.ts` sidecar announces a port, serves the built SPA, and
 *   drives a tool-calling turn against an OpenAI-compatible endpoint
 *
 * See also:
 * - `host.test.ts` for tool catalog composition and turn execution
 * - `packages/client/src/openai-provider.test.ts` for the SSE frame shapes
 *   the fake inference endpoint below reuses
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	AgentEngine,
	AgentToolDefinition,
	EngineChunk,
} from '@epicenter/workspace/agent';
import {
	createSuperChatHost,
	type SuperChatHost,
	type SuperChatHostOptions,
} from './host.ts';
import { createSuperChatServer, type ServerEvent } from './server.ts';

const TOKEN = 'per-launch-secret';

/** A stand-in for the built SPA document; `/` must return it byte-for-byte. */
const PAGE = '<!doctype html><html><body>Super Chat test page</body></html>';

const superChatDir = fileURLToPath(new URL('..', import.meta.url));

function scriptedEngine(scripts: EngineChunk[][]): AgentEngine {
	let step = 0;
	return async function* () {
		const script = scripts[Math.min(step, scripts.length - 1)] ?? [];
		step += 1;
		for (const chunk of script) yield chunk;
	};
}

function testDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'super-chat-server-test-'));
}

function createTestHost(options: Omit<SuperChatHostOptions, 'dataDir'>) {
	return createSuperChatHost({ dataDir: testDataDir(), ...options });
}

async function serveHost(host: SuperChatHost, page: string = PAGE) {
	const { app, websocket } = createSuperChatServer({
		host,
		token: TOKEN,
		page,
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: app.fetch,
		websocket,
	});
	return server;
}

describe('createSuperChatServer', () => {
	test('refuses an empty token at construction', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		expect(() =>
			createSuperChatServer({ host, token: '', page: PAGE }),
		).toThrow(/per-launch token/);
	});

	test('rejects every request without the token, on any route', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			for (const path of [
				'/',
				'/api/session',
				'/api/session/stream',
				'/nope',
			]) {
				const bare = await fetch(server.url.origin + path);
				expect(bare.status).toBe(401);
				const wrong = await fetch(`${server.url.origin}${path}?token=wrong`);
				expect(wrong.status).toBe(401);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('serves the page via query token and the API via bearer', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			// The initial window URL carries the token once as a query parameter,
			// and the response IS the page the server was constructed with.
			const page = await fetch(`${server.url.origin}/?token=${TOKEN}`);
			expect(page.status).toBe(200);
			expect(await page.text()).toBe(PAGE);
			// The tokened navigation must never land in a disk cache keyed by
			// its full URL (ADR-0084: the token dies with the process).
			expect(page.headers.get('cache-control')).toBe('no-store');

			// Subsequent fetches carry it as a bearer header.
			const session = await fetch(`${server.url.origin}/api/session`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(session.status).toBe(200);
			const body = (await session.json()) as {
				tools: AgentToolDefinition[];
				snapshot: { messages: unknown[] };
			};
			const createTodos = body.tools.find(
				(t) => t.name === 'todos__todos_create',
			);
			expect(createTodos).toBeDefined();
			expect(createTodos?.inputSchema).toBeDefined();
			expect(body.snapshot.messages).toEqual([]);

			const oldTools = await fetch(`${server.url.origin}/api/tools`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(oldTools.status).toBe(404);

			const oldWs = await fetch(`${server.url.origin}/ws?token=${TOKEN}`);
			expect(oldWs.status).toBe(404);
		} finally {
			await server.stop(true);
		}
	});

	test('a WebSocket session drives a chat turn and streams snapshots', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([
				[{ type: 'text-delta', delta: 'Hello from the host.' }],
			]),
		});
		const server = await serveHost(host);
		try {
			const url = `${server.url.origin.replace('http', 'ws')}/api/session/stream?token=${TOKEN}`;
			const ws = new WebSocket(url);
			const answered = new Promise<ServerEvent>((resolve, reject) => {
				ws.addEventListener('message', (event) => {
					const parsed = JSON.parse(String(event.data)) as ServerEvent;
					const last = parsed.snapshot.messages.at(-1);
					if (
						!parsed.snapshot.isGenerating &&
						last?.role === 'assistant' &&
						last.parts.some(
							(part) =>
								part.type === 'text' && part.text === 'Hello from the host.',
						)
					) {
						resolve(parsed);
					}
				});
				ws.addEventListener('error', () => reject(new Error('socket error')));
				setTimeout(() => reject(new Error('timed out')), 5000);
			});
			ws.addEventListener('open', () => {
				ws.send(JSON.stringify({ type: 'send', content: 'hi' }));
			});

			const final = await answered;
			expect(final.snapshot.error).toBeNull();
			expect(final.snapshot.messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
			ws.close();
		} finally {
			await server.stop(true);
		}
	});

	test('two sockets share the one host session (the remote-session proof)', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[{ type: 'text-delta', delta: 'Shared.' }]]),
		});
		const server = await serveHost(host);
		try {
			const url = `${server.url.origin.replace('http', 'ws')}/api/session/stream?token=${TOKEN}`;
			const watcher = new WebSocket(url);
			const driver = new WebSocket(url);
			const settledAt = (ws: WebSocket) =>
				new Promise<ServerEvent>((resolve, reject) => {
					ws.addEventListener('message', (event) => {
						const parsed = JSON.parse(String(event.data)) as ServerEvent;
						const last = parsed.snapshot.messages.at(-1);
						if (!parsed.snapshot.isGenerating && last?.role === 'assistant') {
							resolve(parsed);
						}
					});
					setTimeout(() => reject(new Error('timed out')), 5000);
				});
			const bothOpen = Promise.all(
				[watcher, driver].map(
					(ws) =>
						new Promise<void>((resolve) =>
							ws.addEventListener('open', () => resolve()),
						),
				),
			);
			await bothOpen;
			driver.send(
				JSON.stringify({ type: 'send', content: 'hi from device 2' }),
			);

			// The watcher never sent anything, yet sees the same finished turn: one
			// conversation per host process, devices attach to the session
			// (ADR-0080), not to their own thread.
			const [watched, drove] = await Promise.all([
				settledAt(watcher),
				settledAt(driver),
			]);
			expect(watched.snapshot.messages).toEqual(drove.snapshot.messages);
			expect(watched.snapshot.messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
			watcher.close();
			driver.close();
		} finally {
			await server.stop(true);
		}
	});

	test('a WebSocket upgrade without the token is refused', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const ws = new WebSocket(
				`${server.url.origin.replace('http', 'ws')}/api/session/stream`,
			);
			const outcome = await new Promise<'open' | 'refused'>((resolve) => {
				ws.addEventListener('open', () => resolve('open'));
				ws.addEventListener('error', () => resolve('refused'));
				ws.addEventListener('close', () => resolve('refused'));
			});
			expect(outcome).toBe('refused');
		} finally {
			await server.stop(true);
		}
	});
});

// ============================================================================
// Built SPA Tests (the real vite build)
// ============================================================================

let builtPagePromise: Promise<string> | undefined;

/**
 * Run the real vite build once per test run and return dist/index.html.
 * Memoized because both the built-SPA describe and the sidecar smoke need it,
 * and bun test does not guarantee an ordering contract between describes.
 */
function buildSpaOnce(): Promise<string> {
	builtPagePromise ??= (async () => {
		const build = Bun.spawn(['bun', 'x', 'vite', 'build'], {
			cwd: superChatDir,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await build.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(build.stderr).text();
			throw new Error(`vite build exited with ${exitCode}:\n${stderr}`);
		}
		return Bun.file(join(superChatDir, 'dist', 'index.html')).text();
	})();
	return builtPagePromise;
}

describe('the built SPA', () => {
	test('the build emits one self-contained document and the server returns it byte-for-byte', async () => {
		const page = await buildSpaOnce();

		// One inline script, and it must be inline: a `src` attribute would be
		// a second request the token gate 401s (ADR-0084: the page is ONE
		// request; every other request carries the token explicitly).
		const scriptTags = page.match(/<script\b[^>]*>/gi) ?? [];
		expect(scriptTags.length).toBeGreaterThan(0);
		for (const tag of scriptTags) {
			expect(tag).not.toMatch(/\ssrc\s*=/i);
		}
		// No asset-bearing tag may reference an external file. Matching tag
		// attributes (not raw substrings) keeps legitimate inline JS or CSS
		// content from false-positives.
		for (const [tag] of page.matchAll(
			/<(?:img|iframe|source|audio|video|embed)\b[^>]*>/gi,
		)) {
			expect(tag).not.toMatch(/\ssrc\s*=/i);
		}
		expect(page).not.toMatch(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i);
		expect(page).not.toMatch(/<link\b[^>]*\bhref\s*=/i);

		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host, page);
		try {
			const response = await fetch(`${server.url.origin}/?token=${TOKEN}`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(page);
		} finally {
			await server.stop(true);
		}
	}, 60_000);
});

// ============================================================================
// Sidecar End-to-End Smoke (the real main.ts entrypoint)
// ============================================================================

/** Build an OpenAI SSE response: one `data:` frame per chunk, then `[DONE]`. */
function openAiSse(chunks: object[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
				);
			}
			controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

/** First model call: a fragmented streamed tool call to `todos__todos_list`. */
const TOOL_CALL_TURN = [
	{
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: 'call_1',
							type: 'function',
							function: { name: 'todos__todos_list', arguments: '' },
						},
					],
				},
				finish_reason: null,
			},
		],
	},
	{
		choices: [
			{
				delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
				finish_reason: null,
			},
		],
	},
	{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

const FINAL_TEXT = 'Your todo list is empty.';

/** Second model call: the final assistant sentence as text deltas. */
const FINAL_TEXT_TURN = [
	{
		choices: [{ delta: { content: 'Your todo list' }, finish_reason: null }],
	},
	{ choices: [{ delta: { content: ' is empty.' }, finish_reason: null }] },
	{ choices: [{ delta: {}, finish_reason: 'stop' }] },
];

/**
 * Read the sidecar's stdout until the one-line `{"port": N}` announcement.
 * Rejects with the buffered stdout (or the sidecar's stderr, if it exited)
 * so a failed launch names its cause instead of timing out silently.
 */
async function readPortAnnouncement(
	sidecar: {
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
	},
	timeoutMs: number,
): Promise<number> {
	const reader = sidecar.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`no port announcement within ${timeoutMs}ms; stdout so far: ${JSON.stringify(buffer)}`,
				),
			);
		}, timeoutMs);
	});
	try {
		while (true) {
			const { value, done } = await Promise.race([reader.read(), timeout]);
			if (value) {
				buffer += decoder.decode(value, { stream: true });
				const newline = buffer.indexOf('\n');
				if (newline !== -1) {
					const line = buffer.slice(0, newline);
					return (JSON.parse(line) as { port: number }).port;
				}
			}
			if (done) {
				const stderr = await new Response(sidecar.stderr).text();
				throw new Error(
					`the sidecar exited before announcing a port:\n${stderr}`,
				);
			}
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

describe('sidecar end-to-end smoke', () => {
	test('the spawned entrypoint serves the built SPA and drives a tool-calling turn', async () => {
		const page = await buildSpaOnce();

		// The fake OpenAI-compatible backend: first request streams a
		// `todos__todos_list` tool call, second streams the final sentence.
		let inferenceRequests = 0;
		const inference = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (request.method !== 'POST' || pathname !== '/v1/chat/completions') {
					return new Response('Not found', { status: 404 });
				}
				inferenceRequests += 1;
				return openAiSse(
					inferenceRequests === 1 ? TOOL_CALL_TURN : FINAL_TEXT_TURN,
				);
			},
		});

		const sidecar = Bun.spawn(['bun', 'run', 'src/main.ts'], {
			cwd: superChatDir,
			env: {
				...process.env,
				// The engine POSTs `${baseURL}/chat/completions`, so the base
				// carries the `/v1` prefix.
				SUPER_CHAT_INFERENCE_URL: `${inference.url.origin}/v1`,
				SUPER_CHAT_MODEL: 'fake-model',
				// Keep the host's replicas out of the real user data directory.
				SUPER_CHAT_DATA_DIR: testDataDir(),
			},
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		try {
			// The per-launch token travels as the first stdin line, never argv.
			sidecar.stdin.write(`${TOKEN}\n`);
			await sidecar.stdin.flush();
			const port = await readPortAnnouncement(sidecar, 30_000);
			const origin = `http://127.0.0.1:${port}`;

			// The one-request page: exactly the built document.
			const served = await fetch(`${origin}/?token=${TOKEN}`);
			expect(served.status).toBe(200);
			expect(await served.text()).toBe(page);

			// The API behind the bearer exposes the composed catalog and snapshot.
			const session = await fetch(`${origin}/api/session`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(session.status).toBe(200);
			const catalog = (await session.json()) as {
				tools: Array<{ name: string }>;
				snapshot: { messages: unknown[] };
			};
			expect(catalog.tools.map((t) => t.name)).toContain('todos__todos_list');
			expect(catalog.snapshot.messages).toEqual([]);

			// One WebSocket turn: send, then await the settled snapshot.
			const ws = new WebSocket(
				`ws://127.0.0.1:${port}/api/session/stream?token=${TOKEN}`,
			);
			const settled = new Promise<ServerEvent>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error('the turn never settled')),
					20_000,
				);
				ws.addEventListener('message', (event) => {
					const parsed = JSON.parse(String(event.data)) as ServerEvent;
					const last = parsed.snapshot.messages.at(-1);
					if (
						!parsed.snapshot.isGenerating &&
						last?.role === 'assistant' &&
						last.parts.some(
							(part) => part.type === 'text' && part.text.includes(FINAL_TEXT),
						)
					) {
						clearTimeout(timer);
						resolve(parsed);
					}
				});
				ws.addEventListener('error', () => {
					clearTimeout(timer);
					reject(new Error('socket error'));
				});
			});
			ws.addEventListener('open', () => {
				ws.send(JSON.stringify({ type: 'send', content: 'list my todos' }));
			});
			let final: ServerEvent;
			try {
				final = await settled;
			} finally {
				ws.close();
			}

			expect(final.snapshot.error).toBeNull();
			const parts = final.snapshot.messages.flatMap((m) => m.parts);
			expect(parts).toContainEqual(
				expect.objectContaining({
					type: 'tool-call',
					toolName: 'todos__todos_list',
				}),
			);
			expect(parts).toContainEqual(
				expect.objectContaining({
					type: 'tool-result',
					toolName: 'todos__todos_list',
					isError: false,
				}),
			);
			expect(inferenceRequests).toBe(2);
		} finally {
			sidecar.kill();
			await inference.stop(true);
		}
	}, 120_000);
});
