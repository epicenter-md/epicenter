/**
 * The desktop super-app host (ADR-0080 Slice 1): ONE chat that composes the
 * verbs of locally installed apps and dispatches on the user's behalf.
 *
 * It composes only LOCAL surfaces (ADR-0080 decision 1), and never reaches an
 * app over a network:
 *   - arm A (in-process): user-curated Yjs apps opened in this process; each
 *     app's `defineActions` registry becomes a `ToolCatalog` via
 *     `createLocalToolCatalog`. Honeycrisp and Todos here.
 *   - arm B (local stdio MCP): cloud-upstream apps that refuse the mesh expose
 *     curated verbs over a co-located stdio MCP server whose private SQLite
 *     mirror never leaves the subprocess (ADR-0072/0073). Local Books here.
 *
 * Discovery is a STATIC install list (the two arrays below), not a registry or
 * a presence directory. The arms are merged with `namespaceToolCatalog` +
 * `composeToolCatalogs` and fed to the shipped, transport-blind agent loop
 * (`createConversation`), so one chat calls both kinds of verb (ADR-0047).
 *
 * STEP 0 finding wired in: the production node opener `.mount()` is gated on a
 * signed-in cloud session (`defineSessionMount`), so a headless/offline open
 * with persistence does not exist today. Slice 1 needs only the verbs, so arm A
 * opens each Yjs app with its zero-attachment in-memory factory (`create()` /
 * `createTodos()`): no IndexedDB, no SQLite, no sync, no auth. Durability is a
 * later slice, not a Slice 1 requirement.
 *
 * Run: bun run apps/super-app/host.ts
 *   Default: a deterministic scripted engine drives the loop so the slice is
 *   verifiable with no API key. Set SUPER_APP_BASE_URL + SUPER_APP_MODEL
 *   (+ optional SUPER_APP_API_KEY) to drive a real OpenAI-compatible model.
 *   Set SUPER_APP_REMOTE_PORT to also expose the chat over the floor-tier
 *   WebSocket transport (remote-server.ts) so a second device on the same
 *   overlay can watch and drive this same conversation (ADR-0080 decision 5a).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAiAgentEngine } from '@epicenter/client';
import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { createTodos } from '@epicenter/todos';
import {
	type AgentEngine,
	type AgentMessage,
	type Approval,
	type ConversationHandle,
	type EngineChunk,
	type ToolCatalog,
	agentMessageText,
	composeToolCatalogs,
	createConversation,
	createLocalToolCatalog,
	namespaceToolCatalog,
} from '@epicenter/workspace/agent';
import { createInMemoryMessageStore } from './message-store.ts';
import { startRemoteServer } from './remote-server.ts';
import {
	createStdioMcpCatalog,
	type StdioMcpCatalog,
} from './stdio-mcp-catalog.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The install list: each user-curated Yjs app, opened in-process. Its bound
 * action registry is the verb surface; the `name` becomes the tool namespace.
 */
function openYjsApps(): { name: string; catalog: ToolCatalog }[] {
	return [
		{ name: 'honeycrisp', catalog: createLocalToolCatalog(honeycrispWorkspace.create().actions) },
		{ name: 'todos', catalog: createLocalToolCatalog(createTodos().actions) },
	];
}

/** The install list for arm B: each cloud-upstream app's stdio MCP server. */
async function openMcpApps(): Promise<{ name: string; catalog: StdioMcpCatalog }[]> {
	const localBooks = await createStdioMcpCatalog({
		name: 'localbooks',
		command: 'bun',
		args: ['run', join(REPO_ROOT, 'apps', 'local-books', 'src', 'bin.ts'), 'mcp'],
		env: { LOCAL_BOOKS_DIR: join(REPO_ROOT, '.super-app-books') },
	});
	return [{ name: 'localbooks', catalog: localBooks }];
}

/** Slice 1 auto-approves every gated mutation; an interactive prompt is later UI work. */
const AUTO_APPROVE: Approval = {
	decide: () => 'auto',
	request: async () => true,
};

/**
 * A deterministic stand-in for the model so the slice runs with no API key. It
 * reads the LIVE composed catalog: on the first step it asks for one verb from
 * each arm by their real (namespaced) names; once their results are in the
 * transcript it writes a final summary and ends the turn. This proves the loop
 * routes through `composeToolCatalogs` to both arm A (in-process Yjs) and arm B
 * (stdio MCP), which is the Slice 1 deliverable.
 */
function createScriptedEngine(): AgentEngine {
	return async function* (request): AsyncIterable<EngineChunk> {
		const sawToolResult = request.messages.some((m) => m.role === 'tool');
		if (sawToolResult) {
			const results = request.messages
				.filter((m) => m.role === 'tool')
				.map((m) => `- ${m.name}: ${m.content}`)
				.join('\n');
			yield {
				type: 'text-delta',
				delta: `I called one verb on each installed app.\n${results}`,
			};
			return;
		}
		const names = request.tools.map((t) => t.name);
		if (names.includes('todos__todos_create')) {
			yield {
				type: 'tool-call',
				toolCallId: 'call-todo',
				toolName: 'todos__todos_create',
				input: { title: 'Reconcile Q2 books' },
			};
		}
		if (names.includes('localbooks__status')) {
			yield {
				type: 'tool-call',
				toolCallId: 'call-books',
				toolName: 'localbooks__status',
				input: {},
			};
		}
	};
}

/** The real engine when a connection is configured, else the scripted stand-in. */
function resolveEngine(): { engine: AgentEngine; kind: string } {
	const baseURL = process.env.SUPER_APP_BASE_URL;
	const model = process.env.SUPER_APP_MODEL;
	if (baseURL && model) {
		const apiKey = process.env.SUPER_APP_API_KEY;
		const engine = createOpenAiAgentEngine({
			data: () => ({
				baseURL,
				model,
				fetch: (url, init) =>
					globalThis.fetch(url, {
						...init,
						headers: {
							...(init?.headers as Record<string, string>),
							...(apiKey && { authorization: `Bearer ${apiKey}` }),
						},
					}),
				systemPrompts: [
					'You are the super-app: one chat that acts across the user\'s installed apps. Use the available tools to fulfill requests, then summarize what you did.',
				],
			}),
		});
		return { engine, kind: `real (${model} @ ${baseURL})` };
	}
	return { engine: createScriptedEngine(), kind: 'scripted (no API key)' };
}

/** Drive one turn to completion, resolving when the turn stops generating. */
function runOneTurn(chat: ConversationHandle, prompt: string): Promise<AgentMessage[]> {
	return new Promise((resolve) => {
		let started = false;
		const unsubscribe = chat.subscribe(() => {
			const snap = chat.snapshot();
			if (snap.isGenerating) started = true;
			if (started && !snap.isGenerating) {
				unsubscribe();
				// The loop persists each finished message with its own notify; defer a
				// tick so the whole synchronous finalization completes before we read
				// the full transcript.
				setTimeout(() => resolve(chat.snapshot().messages), 0);
			}
		});
		chat.send(prompt);
	});
}

async function main() {
	console.log('== Super-app host: composing local app verbs (ADR-0080 Slice 1) ==\n');

	const yjsApps = openYjsApps();
	const mcpApps = await openMcpApps();

	// Namespace each app's tools so two apps' same-named verbs never collide,
	// then compose into the single catalog the loop consumes.
	const namespaced: ToolCatalog[] = [
		...yjsApps.map((a) => namespaceToolCatalog(a.name, a.catalog)),
		...mcpApps.map((a) => namespaceToolCatalog(a.name, a.catalog)),
	];
	const catalog = composeToolCatalogs(namespaced);

	console.log('Installed apps (static list):');
	for (const a of yjsApps) console.log(`  [A in-process] ${a.name}`);
	for (const a of mcpApps) console.log(`  [B stdio MCP ] ${a.name}`);
	console.log('\nComposed tool surface:');
	for (const def of catalog.definitions()) {
		console.log(`  ${def.kind === 'mutation' ? 'M' : 'Q'}  ${def.name}`);
	}

	const { engine, kind } = resolveEngine();
	console.log(`\nEngine: ${kind}\n`);

	const store = createInMemoryMessageStore();
	const chat = createConversation({
		store,
		engine,
		tools: catalog,
		approval: AUTO_APPROVE,
		generateId: () => crypto.randomUUID(),
	});

	const remotePort = process.env.SUPER_APP_REMOTE_PORT;
	if (remotePort) {
		const remote = startRemoteServer({ chat, port: Number(remotePort) });
		console.log(
			`Remote session listening on ws://<this machine's overlay address>:${remote.port}\n` +
				`Connect with: bun run apps/super-app/remote-client.ts ws://<address>:${remote.port}\n` +
				'Press Ctrl+C to shut down.\n',
		);
		const shutdown = async () => {
			console.log('\n== host shutting down ==');
			remote.stop();
			chat[Symbol.dispose]();
			for (const a of mcpApps) await a.catalog[Symbol.asyncDispose]();
			process.exit(0);
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);
		return; // Stay alive; the remote server keeps the event loop open.
	}

	const prompt = 'Add a todo to reconcile the books, and tell me the books status.';
	console.log(`> user: ${prompt}\n`);
	const messages = await runOneTurn(chat, prompt);

	console.log('--- transcript ---');
	for (const m of messages) {
		const text = agentMessageText(m);
		if (text) console.log(`[${m.role}] ${text}`);
		for (const part of m.parts) {
			if (part.type === 'tool-call') {
				console.log(`  -> call ${part.toolName}(${JSON.stringify(part.input)})`);
			}
			if (part.type === 'tool-result') {
				const out = typeof part.output === 'string' ? part.output : JSON.stringify(part.output);
				console.log(`  <- ${part.toolName} ${part.isError ? '[error] ' : ''}${out}`);
			}
		}
	}

	const err = chat.snapshot().error;
	if (err) console.log(`\n[turn error] ${err.message}`);

	chat[Symbol.dispose]();
	for (const a of mcpApps) await a.catalog[Symbol.asyncDispose]();
	console.log('\n== host shut down ==');
	process.exit(err ? 1 : 0);
}

await main();
