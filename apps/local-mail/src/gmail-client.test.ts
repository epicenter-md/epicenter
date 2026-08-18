/**
 * Gmail Client Tests
 *
 * Verifies the HTTP boundary for the Gmail REST client. These tests pin the
 * request method/body behavior that fakes in sync and modify tests do not
 * exercise.
 *
 * Key behaviors:
 * - messages.modify sends POST with the add/remove label body
 * - messages.trash/untrash POST to their endpoints with no request body
 * - Slim Gmail Message responses validate successfully
 * - one messages.get(format=full) is the entire per-message budget (ADR-0196)
 */

import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { createGmailClient } from './gmail-client.ts';
import type { TokenManager } from './token-manager.ts';

const config: AppConfig = {
	dataDir: '/tmp/local-mail-gmail-client-test',
	apiBase: 'http://127.0.0.1:0',
	authorizeUrl: 'http://127.0.0.1:0/auth',
	tokenUrl: 'http://127.0.0.1:0/token',
	historySafeWindowDays: 5,
	fullBackstopDays: 30,
	pageSize: 100,
	credentialsPath: '/tmp/local-mail-gmail-client-test/credentials.json',
	account: null,
	readOnly: false,
};

const tokens: TokenManager = {
	async getValidAccessToken() {
		return Ok('access-token-123');
	},
	async forceRefresh() {
		return Ok('access-token-123');
	},
};

test('modifyMessage sends POST body and accepts a slim message response', async () => {
	const requests: {
		method: string;
		pathname: string;
		body: unknown;
		authorization: string | null;
		accept: string | null;
		contentType: string | null;
	}[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				body: await request.json(),
				authorization: request.headers.get('authorization'),
				accept: request.headers.get('accept'),
				contentType: request.headers.get('content-type'),
			});
			return Response.json({
				id: 'm1',
				threadId: 't-m1',
				labelIds: ['INBOX', 'Label_1'],
			});
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.modifyMessage('m1', {
			addLabelIds: ['Label_1'],
			removeLabelIds: ['UNREAD'],
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			id: 'm1',
			threadId: 't-m1',
			labelIds: ['INBOX', 'Label_1'],
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				pathname: '/gmail/v1/users/me/messages/m1/modify',
				body: {
					addLabelIds: ['Label_1'],
					removeLabelIds: ['UNREAD'],
				},
				authorization: 'Bearer access-token-123',
				accept: 'application/json',
				contentType: 'application/json',
			},
		]);
	} finally {
		server.stop(true);
	}
});

test('trashMessage POSTs to the trash endpoint with no body and folds labelIds', async () => {
	const requests: {
		method: string;
		pathname: string;
		body: string;
		contentType: string | null;
	}[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				body: await request.text(),
				contentType: request.headers.get('content-type'),
			});
			// Gmail's trash response: TRASH added, INBOX dropped.
			return Response.json({ id: 'm1', threadId: 't-m1', labelIds: ['TRASH'] });
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.trashMessage('m1');

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			id: 'm1',
			threadId: 't-m1',
			labelIds: ['TRASH'],
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				pathname: '/gmail/v1/users/me/messages/m1/trash',
				body: '',
				contentType: null,
			},
		]);
	} finally {
		server.stop(true);
	}
});

test('untrashMessage POSTs to the untrash endpoint with no body', async () => {
	const requests: { method: string; pathname: string; body: string }[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				pathname: url.pathname,
				body: await request.text(),
			});
			return Response.json({
				id: 'm1',
				threadId: 't-m1',
				labelIds: ['INBOX'],
			});
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.untrashMessage('m1');

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			id: 'm1',
			threadId: 't-m1',
			labelIds: ['INBOX'],
		});
		expect(requests).toEqual([
			{
				method: 'POST',
				pathname: '/gmail/v1/users/me/messages/m1/untrash',
				body: '',
			},
		]);
	} finally {
		server.stop(true);
	}
});

test('fetching a message spends exactly one format=full call and nothing else', async () => {
	// The invariant this app is built on (ADR-0196): one
	// `messages.get(format=full)` per message, no `format=raw` second call, and
	// no `messages.attachments.get`. `messages.get` costs 20 quota units against
	// a 6,000/minute per-user ceiling, so a second per-message call would roughly
	// double every rebuild.
	const requests: { pathname: string; format: string | null }[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				pathname: url.pathname,
				format: url.searchParams.get('format'),
			});
			return Response.json({
				id: 'm1',
				threadId: 't-m1',
				labelIds: ['INBOX'],
				payload: {
					mimeType: 'text/plain',
					// Gmail externalized this body. The client returns it as-is; nothing
					// follows up to fetch the bytes.
					body: { attachmentId: 'ANGjdJ8', size: 900_000 },
					headers: [{ name: 'Subject', value: 'Big one' }],
				},
			});
		},
	});

	try {
		const client = createGmailClient({
			config: { ...config, apiBase: `http://127.0.0.1:${server.port}` },
			tokens,
		});

		const result = await client.getMessage('m1');

		expect(result.error).toBeNull();
		expect(requests).toEqual([
			{ pathname: '/gmail/v1/users/me/messages/m1', format: 'full' },
		]);
		expect(requests.some((r) => r.format === 'raw')).toBe(false);
		expect(requests.some((r) => r.pathname.includes('/attachments/'))).toBe(
			false,
		);
		// The client has no attachment surface at all, so no caller can add the
		// second call by accident.
		expect(Object.keys(client).some((name) => /attachment/i.test(name))).toBe(
			false,
		);
	} finally {
		server.stop(true);
	}
});
