import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineMutation, defineQuery } from '../shared/actions';
import { collectActionPaths, createActionsRouter } from './actions';

// Mock client for closure-based actions
const mockClient = { id: 'test' };

describe('createActionsRouter', () => {
	test('creates routes for flat actions', async () => {
		const actions = {
			ping: defineQuery({
				handler: () => 'pong',
			}),
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(new Request('http://test/actions/ping'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: 'pong' });
	});

	test('creates routes for nested actions', async () => {
		const actions = {
			posts: {
				list: defineQuery({
					handler: () => ['post1', 'post2'],
				}),
			},
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/posts/list'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: ['post1', 'post2'] });
	});

	test('query actions respond to GET requests', async () => {
		const actions = {
			getStatus: defineQuery({
				handler: () => ({ status: 'ok' }),
			}),
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/getStatus', { method: 'GET' }),
		);

		expect(response.status).toBe(200);
	});

	test('mutation actions respond to POST requests', async () => {
		let called = false;
		const actions = {
			doSomething: defineMutation({
				handler: () => {
					called = true;
					return { done: true };
				},
			}),
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/doSomething', { method: 'POST' }),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(called).toBe(true);
		expect(body).toEqual({ data: { done: true } });
	});

	test('mutation actions accept JSON body input', async () => {
		let capturedInput: unknown = null;
		const actions = {
			create: defineMutation({
				input: type({ title: 'string' }),
				handler: (input) => {
					capturedInput = input;
					return { id: '123', title: input.title };
				},
			}),
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Hello World' }),
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(capturedInput).toEqual({ title: 'Hello World' });
		expect(body).toEqual({ data: { id: '123', title: 'Hello World' } });
	});

	test('validates input and returns 422 for invalid data', async () => {
		const actions = {
			create: defineMutation({
				input: type({ title: 'string', count: 'number' }),
				handler: ({ title, count }) => ({ title, count }),
			}),
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Hello', count: 'not-a-number' }),
			}),
		);

		expect(response.status).toBe(422);
	});

	test('async handlers work correctly', async () => {
		const actions = {
			asyncQuery: defineQuery({
				handler: async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return { async: true };
				},
			}),
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/asyncQuery'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: { async: true } });
	});

	test('supports custom base path', async () => {
		const actions = {
			test: defineQuery({
				handler: () => 'ok',
			}),
		};

		const app = createActionsRouter({
			client: mockClient,
			actions,
			basePath: '/api',
		});
		const response = await app.handle(new Request('http://test/api/test'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: 'ok' });
	});

	test('deeply nested actions create correct routes', async () => {
		const actions = {
			api: {
				v1: {
					users: {
						list: defineQuery({
							handler: () => [],
						}),
					},
				},
			},
		};

		const app = createActionsRouter({ client: mockClient, actions });
		const response = await app.handle(
			new Request('http://test/actions/api/v1/users/list'),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ data: [] });
	});
});

describe('collectActionPaths', () => {
	test('collects flat action paths', () => {
		const actions = {
			ping: defineQuery({ handler: () => 'pong' }),
			sync: defineMutation({ handler: () => {} }),
		};

		const paths = collectActionPaths(actions);

		expect(paths).toContain('ping');
		expect(paths).toContain('sync');
		expect(paths).toHaveLength(2);
	});

	test('collects nested action paths', () => {
		const actions = {
			posts: {
				list: defineQuery({ handler: () => [] }),
				create: defineMutation({ handler: () => {} }),
			},
			users: {
				get: defineQuery({ handler: () => null }),
			},
		};

		const paths = collectActionPaths(actions);

		expect(paths).toContain('posts/list');
		expect(paths).toContain('posts/create');
		expect(paths).toContain('users/get');
		expect(paths).toHaveLength(3);
	});

	test('handles deeply nested actions', () => {
		const actions = {
			api: {
				v1: {
					users: {
						list: defineQuery({ handler: () => [] }),
					},
				},
			},
		};

		const paths = collectActionPaths(actions);

		expect(paths).toEqual(['api/v1/users/list']);
	});

	test('returns empty array for empty actions', () => {
		const paths = collectActionPaths({});

		expect(paths).toEqual([]);
	});
});
