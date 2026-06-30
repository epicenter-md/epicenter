/**
 * STEP 0 de-risk (throwaway, not part of the shipped slice).
 *
 * Proves the load-bearing question behind ADR-0080 Slice 1: can two real apps
 * co-mount in ONE host process and both answer a tool call, and what collides?
 *
 * Four probes:
 *   A. Two distinct in-process Yjs apps (honeycrisp + todos) opened side by side,
 *      both verbs resolved through createLocalToolCatalog. (The real in-process
 *      collision test: sync conn / IDB-SQLite attachment / module singleton.)
 *   B. honeycrisp's PRODUCTION node opener `.mount()` opened with a signed-out
 *      context, to see whether a headless/offline open is even possible.
 *   C. local-books spawned as a stdio MCP subprocess, listed and called over a
 *      StdioClientTransport (arm B).
 *
 * Run: bun run apps/super-app/derisk.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { honeycrisp } from '@epicenter/honeycrisp/mount';
import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { createTodos } from '@epicenter/todos';
import { createLocalToolCatalog } from '@epicenter/workspace/agent';
import { createNodeId } from '@epicenter/workspace';

const NO_SIGNAL = new AbortController().signal;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function log(probe: string, msg: string, extra?: unknown) {
	console.log(
		`[${probe}] ${msg}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`,
	);
}

// ── Probe A: two Yjs apps co-mounted in-process ────────────────────────────────
async function probeAInProcessComount() {
	log('A', 'opening honeycrisp (create) + todos (createTodos) in one process');
	const hc = honeycrispWorkspace.create();
	const todos = createTodos();

	const hcCatalog = createLocalToolCatalog(hc.actions);
	const todosCatalog = createLocalToolCatalog(todos.actions);
	log('A', 'honeycrisp tools', hcCatalog.definitions().map((d) => d.name));
	log('A', 'todos tools', todosCatalog.definitions().map((d) => d.name));

	// Run a real verb on each app's live tables.
	const todoOut = await todosCatalog.resolve(
		{ toolCallId: '1', toolName: 'todos_create', input: { title: 'buy milk' } },
		NO_SIGNAL,
	);
	log('A', 'todos_create outcome', todoOut);

	// Seed a folder on honeycrisp, then delete it through the verb.
	const folderId = 'f-derisk';
	hc.tables.folders.set({ id: folderId as never, name: 'Inbox', icon: null, sortOrder: 0 });
	log('A', 'honeycrisp folders before', hc.tables.folders.scan().rows.length);
	const hcOut = await hcCatalog.resolve(
		{ toolCallId: '2', toolName: 'folders_delete', input: { folderId } },
		NO_SIGNAL,
	);
	log('A', 'folders_delete outcome', hcOut);
	log('A', 'honeycrisp folders after', hc.tables.folders.scan().rows.length);
	log('A', 'todos rows after', todos.tables.todos.scan().rows.length);

	hc[Symbol.dispose]?.();
	todos[Symbol.dispose]?.();
	log('A', 'disposed both; no throw on co-dispose');
}

// ── Probe B: production node opener (.mount) signed-out ─────────────────────────
async function probeBProductionMount() {
	log('B', 'building honeycrisp() Mount and opening with session=null');
	const mount = honeycrisp();
	const mem = new Map<string, string>();
	const nodeId = createNodeId({
		storage: {
			getItem: (k) => mem.get(k) ?? null,
			setItem: (k, v) => void mem.set(k, v),
		},
	});
	const result = await mount.open({
		epicenterRoot: REPO_ROOT as never,
		mount: mount.name,
		nodeId,
		session: null,
	});
	if ('inactive' in result) {
		log('B', 'mount returned INACTIVE (auth coupling confirmed)', {
			reason: result.reason,
		});
	} else {
		log('B', 'mount opened ACTIVE while signed out (no auth coupling)', {
			tools: Object.keys(result.actions ?? {}),
		});
	}
}

// ── Probe C: local-books stdio MCP subprocess (arm B) ──────────────────────────
async function probeCStdioMcp() {
	const binPath = join(REPO_ROOT, 'apps', 'local-books', 'src', 'bin.ts');
	log('C', 'spawning local-books mcp subprocess', { binPath });
	const transport = new StdioClientTransport({
		command: 'bun',
		args: ['run', binPath, 'mcp'],
		env: { ...process.env, LOCAL_BOOKS_DIR: join(REPO_ROOT, '.derisk-books') },
	});
	const client = new Client({ name: 'super-app-derisk', version: '0.0.0' });
	await client.connect(transport);
	const listed = await client.listTools();
	log('C', 'tools/list', listed.tools.map((t) => t.name));

	const status = await client.callTool({ name: 'status', arguments: {} });
	log('C', 'status call returned (round trip ok)', {
		isError: status.isError ?? false,
		textPreview: JSON.stringify(status.content).slice(0, 160),
	});
	await client.close();
	log('C', 'subprocess closed');
}

const start = Date.now();
await probeAInProcessComount();
await probeBProductionMount();
await probeCStdioMcp();
log('done', `all probes finished in ${Date.now() - start}ms`);
process.exit(0);
