import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createAIPlugin } from './plugin';

/** Build a POST /chat request for the given path, body, and optional headers. */
function chatRequest(
	path: string,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
) {
	return new Request(`http://test${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

describe('createAIPlugin', () => {
	test('returns 401 when x-provider-api-key header is missing', async () => {
		const app = new Elysia().use(createAIPlugin());

		const response = await app.handle(
			chatRequest('/chat', {
				messages: [{ role: 'user', content: 'Hello' }],
				provider: 'openai',
				model: 'gpt-4o',
			}),
		);

		expect(response.status).toBe(401);
		const body = await response.text();
		expect(body).toContain('Missing API key');
	});

	test('returns 400 for unsupported provider', async () => {
		const app = new Elysia().use(createAIPlugin());

		const response = await app.handle(
			chatRequest(
				'/chat',
				{
					messages: [{ role: 'user', content: 'Hello' }],
					provider: 'mistral',
					model: 'mistral-large',
				},
				{ 'x-provider-api-key': 'sk-test-key' },
			),
		);

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe('Unsupported provider: mistral');
	});

	test('returns 422 when required body fields are missing', async () => {
		const app = new Elysia().use(createAIPlugin());

		const response = await app.handle(
			chatRequest(
				'/chat',
				{ messages: [] },
				{ 'x-provider-api-key': 'sk-test-key' },
			),
		);

		// Elysia returns 422 for schema validation failures
		expect(response.status).toBe(422);
	});

	test('unsupported provider returns 400 (ollama removed)', async () => {
		const app = new Elysia().use(createAIPlugin());

		const response = await app.handle(
			chatRequest('/chat', {
				messages: [{ role: 'user', content: 'Hello' }],
				provider: 'ollama',
				model: 'llama3',
			}),
		);

		// Ollama is no longer a supported provider
		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe('Unsupported provider: ollama');
	});

	test('route is reachable through Elysia prefix mount', async () => {
		const app = new Elysia().use(
			new Elysia({ prefix: '/ai' }).use(createAIPlugin()),
		);

		const response = await app.handle(
			chatRequest('/ai/chat', {
				messages: [{ role: 'user', content: 'Hello' }],
				provider: 'openai',
				model: 'gpt-4o',
			}),
		);

		// Should hit our handler (401 because no API key), not 404
		expect(response.status).toBe(401);
	});

	test('resolveApiKey returns header key when both header and env var present', async () => {
		const { resolveApiKey } = await import('./adapters');
		process.env.OPENAI_API_KEY = 'sk-env-key';
		try {
			expect(resolveApiKey('openai', 'sk-header-key')).toBe('sk-header-key');
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});

	test('resolveApiKey returns env var key when header absent', async () => {
		const { resolveApiKey } = await import('./adapters');
		process.env.OPENAI_API_KEY = 'sk-env-key';
		try {
			expect(resolveApiKey('openai')).toBe('sk-env-key');
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});

	test('resolveApiKey returns undefined when neither present', async () => {
		const { resolveApiKey } = await import('./adapters');
		delete process.env.OPENAI_API_KEY;
		expect(resolveApiKey('openai')).toBeUndefined();
	});

	test('401 error message mentions env var name', async () => {
		const app = new Elysia().use(createAIPlugin());
		delete process.env.OPENAI_API_KEY;

		const response = await app.handle(
			chatRequest('/chat', {
				messages: [{ role: 'user', content: 'Hello' }],
				provider: 'openai',
				model: 'gpt-4o',
			}),
		);

		expect(response.status).toBe(401);
		const body = await response.text();
		expect(body).toContain('OPENAI_API_KEY');
	});

	test('plugin accepts request without header when env var set', async () => {
		const app = new Elysia().use(createAIPlugin());
		process.env.OPENAI_API_KEY = 'sk-test-env-key';

		try {
			const response = await app.handle(
				chatRequest('/chat', {
					messages: [{ role: 'user', content: 'Hello' }],
					provider: 'openai',
					model: 'gpt-4o',
				}),
			);

			// Should NOT be 401 — env var provides the key
			expect(response.status).not.toBe(401);
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
	});
});
