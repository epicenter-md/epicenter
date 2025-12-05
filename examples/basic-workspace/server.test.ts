import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer } from '@epicenter/hq';
import epicenterConfig from './epicenter.config';

// Helper to parse SSE response from MCP endpoint
async function parseMcpResponse(response: Response): Promise<any> {
	const text = await response.text();
	// SSE format: "event: message\ndata: {json}\n\n"
	const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
	if (!dataLine) throw new Error('No data in SSE response');
	return JSON.parse(dataLine.substring(6)); // Remove "data: " prefix
}

describe('Server Tests', () => {
	let server: any;
	let baseUrl: string;

	beforeAll(async () => {
		const { app, websocket } = await createServer(epicenterConfig);
		server = Bun.serve({
			fetch: app.fetch,
			websocket,
			port: 0, // Random available port
		});
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop();
	});

	describe('REST Endpoints - Basic CRUD', () => {
		test('creates a post via POST /blog/createPost', async () => {
			const response = await fetch(`${baseUrl}/blog/createPost`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'Test Post',
					content: 'This is a test post',
					category: 'tech',
				}),
			});

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.data).toBeDefined();
			expect(data.data.title).toBe('Test Post');
			expect(data.data.category).toBe('tech');
			expect(data.data.publishedAt).toBeNull();
		});

		test('adds a comment via POST /blog/addComment', async () => {
			// Create a post first
			const postResponse = await fetch(`${baseUrl}/blog/createPost`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'Post with Comments',
					category: 'tutorial',
				}),
			});
			const postData = await postResponse.json();
			const postId = postData.data.id;

			// Add comment
			const response = await fetch(`${baseUrl}/blog/addComment`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					postId,
					author: 'Test User',
					content: 'Great post!',
				}),
			});

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.data).toBeDefined();
			expect(data.data.author).toBe('Test User');
			expect(data.data.postId).toBe(postId);
		});
	});

	describe('MCP Protocol', () => {
		test('lists all available MCP tools', async () => {
			const response = await fetch(`${baseUrl}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
				}),
			});

			expect(response.status).toBe(200);
			const data = await parseMcpResponse(response);
			expect(data.result).toBeDefined();
			expect(data.result.tools).toBeDefined();
			expect(Array.isArray(data.result.tools)).toBe(true);

			const toolNames = data.result.tools.map((t: any) => t.name);
			expect(toolNames).toContain('blog_createPost');
			expect(toolNames).toContain('blog_getPublishedPosts');
			expect(toolNames).toContain('blog_publishPost');
		});

		test('calls MCP tool to create a post', async () => {
			const response = await fetch(`${baseUrl}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: {
						name: 'blog_createPost',
						arguments: {
							title: 'MCP Test Post',
							category: 'tutorial',
						},
					},
				}),
			});

			expect(response.status).toBe(200);
			const data = await parseMcpResponse(response);
			expect(data.result).toBeDefined();
			expect(data.result.content).toBeDefined();
			expect(data.result.content[0].type).toBe('text');
			expect(data.result.isError).toBeUndefined();

			const result = JSON.parse(data.result.content[0].text);
			expect(result.title).toBe('MCP Test Post');
			expect(result.category).toBe('tutorial');
		});

		test('calls MCP tool to add a comment', async () => {
			// Create a post first
			const postResponse = await fetch(`${baseUrl}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: {
						name: 'blog_createPost',
						arguments: {
							title: 'Post for MCP Comment',
							category: 'tech',
						},
					},
				}),
			});
			const postData = await parseMcpResponse(postResponse);
			const post = JSON.parse(postData.result.content[0].text);

			// Add comment via MCP
			const response = await fetch(`${baseUrl}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: {
						name: 'blog_addComment',
						arguments: {
							postId: post.id,
							author: 'MCP User',
							content: 'Comment via MCP',
						},
					},
				}),
			});

			expect(response.status).toBe(200);
			const data = await parseMcpResponse(response);
			expect(data.result.isError).toBeUndefined();
			const comment = JSON.parse(data.result.content[0].text);
			expect(comment.author).toBe('MCP User');
		});
	});
});
