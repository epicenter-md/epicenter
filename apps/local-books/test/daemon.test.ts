/**
 * The `local-books daemon` HTTP `/mcp` endpoint.
 *
 * Two things this proves about the capability-plane box surface (ADR-0079):
 *  - a real MCP client, over Streamable HTTP, lists and calls the books tools
 *    and gets mirror rows back (the same airlock as the stdio verb, on HTTP);
 *  - the CORS layer blesses a browser on a tailnet device (preflight + the
 *    headers the MCP client needs), and an allowlist restricts who may reach it.
 *
 * No token, no session: stateless HTTP, tailnet ACLs are the network authz.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createDaemonFetch } from '../src/commands/daemon.ts';
import { createBooksServerDeps } from '../src/commands/mcp-server.ts';
import { openBooksDb } from '../src/db.ts';
import { makeConfig, tempDir } from './helpers.ts';

const REALM = 'r1';

/** Seed a mirror at <dir>/r1/books.db with two live invoices. */
function seedMirror(dir: string): void {
	const db = openBooksDb(join(dir, REALM, 'books.db'));
	db.raw.exec(`
		CREATE TABLE invoices (
			id TEXT PRIMARY KEY, raw TEXT NOT NULL, updated_at TEXT,
			synced_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
			doc_number TEXT, total_amt REAL
		);
		INSERT INTO invoices (id, raw, synced_at, deleted, doc_number, total_amt) VALUES
			('1', '{"Id":"1"}', '2026-01-01', 0, 'INV-1', 8000.0),
			('2', '{"Id":"2"}', '2026-01-01', 0, 'INV-2', 4500.0);
	`);
	db.close();
}

test('daemon: a Streamable HTTP MCP client lists tools and queries mirror rows', async () => {
	const tmp = tempDir();
	seedMirror(tmp.dir);
	const config = makeConfig({ dataDir: tmp.dir, realmOverride: REALM });
	const server = Bun.serve({
		port: 0,
		fetch: createDaemonFetch(createBooksServerDeps(config)),
	});

	const client = new Client({ name: 'daemon-test', version: '0.0.0' });
	const transport = new StreamableHTTPClientTransport(
		new URL(`http://localhost:${server.port}/mcp`),
	);

	try {
		await client.connect(transport);

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(['query', 'recategorize', 'report', 'status', 'sync']);

		const result = await client.callTool({
			name: 'query',
			arguments: {
				sql: 'SELECT doc_number, total_amt FROM invoices WHERE deleted = 0 ORDER BY total_amt DESC',
			},
		});
		expect(result.isError).toBeFalsy();
		const data = result.structuredContent as {
			rows: Array<{ doc_number: string; total_amt: number }>;
			rowCount: number;
		};
		expect(data.rowCount).toBe(2);
		expect(data.rows[0]).toEqual({ doc_number: 'INV-1', total_amt: 8000 });
	} finally {
		await client.close();
		server.stop(true);
		tmp.cleanup();
	}
});

test('daemon: CORS preflight advertises the methods and headers the MCP client needs', async () => {
	const config = makeConfig({ dataDir: '/tmp/unused', realmOverride: REALM });
	const fetch = createDaemonFetch(createBooksServerDeps(config), {
		corsOrigins: ['https://epicenter.so'],
	});

	const preflight = await fetch(
		new Request('http://box.ts.net/mcp', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://epicenter.so',
				'access-control-request-method': 'POST',
			},
		}),
	);
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get('access-control-allow-methods')).toContain(
		'POST',
	);
	const allowHeaders =
		preflight.headers.get('access-control-allow-headers') ?? '';
	expect(allowHeaders).toContain('content-type');
	expect(allowHeaders).toContain('mcp-protocol-version');
});

test('daemon: CORS fails closed: no browser origin is granted without an allowlist', async () => {
	const config = makeConfig({ dataDir: '/tmp/unused', realmOverride: REALM });
	// Default deps: empty allowlist. A browser must NOT receive a read grant, or
	// any website a tailnet device visits could read the books cross-origin.
	const fetch = createDaemonFetch(createBooksServerDeps(config));
	const origin = 'https://epicenter.so';

	const preflight = await fetch(
		new Request('http://box.ts.net/mcp', {
			method: 'OPTIONS',
			headers: { origin },
		}),
	);
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

	const actual = await fetch(
		new Request('http://box.ts.net/nope', { headers: { origin } }),
	);
	expect(actual.status).toBe(404);
	expect(actual.headers.get('access-control-allow-origin')).toBeNull();
});

test('daemon: an allowlist grants a listed origin and refuses every other', async () => {
	const config = makeConfig({ dataDir: '/tmp/unused', realmOverride: REALM });
	const fetch = createDaemonFetch(createBooksServerDeps(config), {
		corsOrigins: ['https://epicenter.so'],
	});

	const blessed = await fetch(
		new Request('http://box.ts.net/mcp', {
			method: 'OPTIONS',
			headers: { origin: 'https://epicenter.so' },
		}),
	);
	expect(blessed.headers.get('access-control-allow-origin')).toBe(
		'https://epicenter.so',
	);

	const refused = await fetch(
		new Request('http://box.ts.net/mcp', {
			method: 'OPTIONS',
			headers: { origin: 'https://evil.example' },
		}),
	);
	expect(refused.headers.get('access-control-allow-origin')).toBeNull();
});
