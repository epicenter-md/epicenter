import { expect, test } from 'bun:test';
import type { AppStorageRequest } from './protocol.js';
import { createDesktopBinding } from './desktop.js';

function ownerFor(
	answer: (request: AppStorageRequest) => Response,
): { calls: AppStorageRequest[]; fetch: typeof globalThis.fetch } {
	const calls: AppStorageRequest[] = [];
	const fetchImplementation = (async (_url: string, init?: RequestInit) => {
		const request = JSON.parse(String(init?.body)) as AppStorageRequest;
		calls.push(request);
		return answer(request);
	}) as unknown as typeof globalThis.fetch;
	return { calls, fetch: fetchImplementation };
}

const DEFINITION = { id: 'so.epicenter.test', title: 'Test' };

test('opening data sends the definition identity, not the definition', async () => {
	const owner = ownerFor((request) =>
		Response.json({
			kind: request.kind,
			dataId: 'so.epicenter.test',
			title: 'Test',
		}),
	);
	const binding = createDesktopBinding({
		appId: 'so.epicenter.test',
		baseURL: 'http://127.0.0.1:1',
		fetch: owner.fetch,
	});

	// The store itself is client-owned, so opening it fails without IndexedDB
	// here. What this pins is the message that reaches the owner.
	await binding.openData(DEFINITION as never).catch(() => undefined);

	expect(owner.calls).toEqual([
		{ kind: 'data-open', appId: 'so.epicenter.test', dataId: 'so.epicenter.test' },
	]);
	expect(JSON.stringify(owner.calls[0])).not.toContain('tables');
});

test('an unadmitted data id reports which id the release does not ship', async () => {
	const owner = ownerFor(() => new Response('Not Found', { status: 404 }));
	const binding = createDesktopBinding({
		appId: 'so.epicenter.test',
		baseURL: 'http://127.0.0.1:1',
		fetch: owner.fetch,
	});

	const result = await binding.openData({
		id: 'so.epicenter.absent',
	} as never);
	expect(result.error?.name).toBe('UnknownData');
});

test('statements and secrets reach the owner scoped by application', async () => {
	const owner = ownerFor((request) => {
		if (request.kind === 'sqlite-all') {
			return Response.json({ kind: 'sqlite-all', rows: [{ id: 'one' }] });
		}
		if (request.kind === 'secret-get') {
			return Response.json({ kind: 'secret-get', value: 'refresh' });
		}
		return Response.json({ kind: request.kind });
	});
	const binding = createDesktopBinding({
		appId: 'so.epicenter.test',
		baseURL: 'http://127.0.0.1:1',
		fetch: owner.fetch,
	});

	const sqlite = await binding.openSqlite('mail');
	if (sqlite.error !== null) throw sqlite.error;
	const rows = await sqlite.data.all('SELECT id FROM messages');
	expect(rows.data).toEqual([{ id: 'one' }]);

	await binding.secrets.put('account-1', 'refresh');
	const secret = await binding.secrets.get('account-1');
	expect(secret.data).toBe('refresh');

	expect(owner.calls.map((call) => call.kind)).toEqual([
		'sqlite-all',
		'secret-put',
		'secret-get',
	]);
	expect(owner.calls.every((call) => call.appId === 'so.epicenter.test')).toBe(
		true,
	);
});
