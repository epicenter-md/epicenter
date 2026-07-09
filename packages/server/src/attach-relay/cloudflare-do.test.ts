/**
 * `AttachHub` Durable Object backend proof (ADR-0115): one per-principal actor
 * that is BOTH the Cloud attach transport and the Cloud host-discovery source.
 *
 * `cloud-attach.test.ts` proves the account-mediated invariant through the mount
 * over the Bun transport (resolver output -> stamped principal -> coordinator
 * partition). `host-directory-store.test.ts` proves the Bun discovery join. This
 * file proves the same invariants ride the Cloudflare backend, and that discovery
 * is a read-time join inside the same actor that holds the sockets (no separate
 * directory DO, no pushed liveness flag):
 *
 *  - A host and a client of ONE principal route to ONE hub, so the in-hub
 *    coordinator pairs them and forwards live bytes both ways. Because the
 *    registry stamps the server-resolved principal onto the forwarded URL, this
 *    holds even when the connect query claims a different principal.
 *  - A client whose server-resolved principal differs routes to a DIFFERENT hub
 *    (a different name), so it pairs with no host: HOST_NOT_FOUND.
 *  - A host lists `online` while its socket is live and `offline` (retained, not
 *    dropped) once it closes: an asleep desktop still lists.
 *  - The directory is partitioned by principal, so one account never reads
 *    another's hosts.
 *  - A refused second host (HOST_CONFLICT) never displaces the incumbent's
 *    `online` nor overwrites its label (conflict-correct liveness).
 *  - Every listed entry parses under the closed schema and nothing else leaks in.
 *
 * Bun's runtime provides no Cloudflare Workers globals, so we mock
 * `cloudflare:workers` (the `DurableObject` base), shim `WebSocketPair` with a
 * cross-linked stub pair that dispatches `message`/`close` events between the two
 * halves, and give each real hub an in-memory `ctx.storage`, then drive the hub
 * through its public `fetch()` (via the registry) and `list()` (via the reader
 * factory), inspecting the stub sockets.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { type } from 'arktype';
import { RELAY_CLOSE } from './contracts.js';
import { AttachHostDirectoryEntry } from './host-directory.js';

// ────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS SHIMS
// ────────────────────────────────────────────────────────────────────────────

type SocketEvent = { data?: string; code?: number; reason?: string };
type Listener = (event: SocketEvent) => void;
type EventType = 'message' | 'close' | 'error';

/**
 * A minimal standard-accept WebSocket half. `send` crosses to the PEER half's
 * message listeners (and records into `sent`); `close` fires this half's OWN
 * close listeners (the ones the hub registers on its `server` socket) and the
 * peer's, and records into `closes`. So a test reads the server half directly and
 * closing it drives the hub's disconnect.
 */
class StubWebSocket {
	readyState = 1 /* OPEN */;
	accepted = false;
	peer!: StubWebSocket;
	sent: string[] = [];
	closes: Array<{ code: number; reason: string }> = [];
	readonly listeners: Record<EventType, Listener[]> = {
		message: [],
		close: [],
		error: [],
	};

	accept(): void {
		this.accepted = true;
	}

	addEventListener(type: EventType, fn: Listener): void {
		this.listeners[type].push(fn);
	}

	send(data: string): void {
		this.sent.push(data);
		for (const fn of this.peer.listeners.message) fn({ data });
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3 /* CLOSED */;
		for (const fn of this.listeners.close) fn({ code, reason });
		for (const fn of this.peer.listeners.close) fn({ code, reason });
	}
}

const webSocketPairs: Array<{ client: StubWebSocket; server: StubWebSocket }> =
	[];

class StubWebSocketPair {
	0: StubWebSocket;
	1: StubWebSocket;
	constructor() {
		const client = new StubWebSocket();
		const server = new StubWebSocket();
		client.peer = server;
		server.peer = client;
		this[0] = client;
		this[1] = server;
		webSocketPairs.push({ client, server });
	}
}

// `WebSocketPair` is a Workers global the hub's `fetch` mints. Install this stub
// only around this file's own tests and restore the prior value afterward, so a
// sibling DO test file is never clobbered in the shared Bun test process.
let priorWebSocketPair: unknown;
beforeAll(() => {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
	priorWebSocketPair = (globalThis as any).WebSocketPair;
	// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
	(globalThis as any).WebSocketPair = StubWebSocketPair;
});
afterAll(() => {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
	(globalThis as any).WebSocketPair = priorWebSocketPair;
});

// `cloudflare:workers` is not resolvable in Bun. Mock it with a barebones
// DurableObject base that records `ctx`/`env` so the AttachHub constructor runs.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

// ────────────────────────────────────────────────────────────────────────────
// DRIVER
// ────────────────────────────────────────────────────────────────────────────

const HOST_ID = 'host-mac';
const LABEL = "Braden's Mac";
const PRINCIPAL_A = 'user-a';
const PRINCIPAL_B = 'user-b';

/**
 * A `DurableObjectState`-shaped stub: an in-memory `ctx.storage` (the key/value
 * subset the hub uses: `put`, `list({ prefix })`) plus a synchronous `waitUntil`
 * that collects the hub's fire-and-forget membership write so a `drain()` flushes
 * it before a discovery read.
 */
function makeCtx() {
	const store = new Map<string, unknown>();
	const pending: Promise<unknown>[] = [];
	return {
		waitUntil: (p: Promise<unknown>) => {
			pending.push(p);
		},
		drain: () => Promise.all(pending.splice(0)),
		storage: {
			put: async (key: string, value: unknown) => {
				store.set(key, value);
			},
			get: async (key: string) => store.get(key),
			list: async ({ prefix }: { prefix: string }) => {
				const out = new Map<string, unknown>();
				for (const [k, v] of store) if (k.startsWith(prefix)) out.set(k, v);
				return out;
			},
		},
	};
}

/**
 * A fake `DurableObjectNamespace` of real `AttachHub` instances, one per DO name
 * (one per principal, each with its own in-memory `ctx.storage`). `get(id)`
 * memoizes an instance and exposes both `fetch` (the relay upgrade) and `list`
 * (the discovery read), so the relay handler and the directory reader drive the
 * SAME actor. `settle()` flushes every hub's pending membership writes.
 */
async function makeHub() {
	// Dynamic import so the cloudflare:workers mock is in place first.
	const {
		AttachHub,
		createDurableObjectAttachHub,
		createDurableObjectHostDirectory,
	} = await import('./cloudflare-do.js');

	const ctxs: ReturnType<typeof makeCtx>[] = [];
	const instances = new Map<string, InstanceType<typeof AttachHub>>();
	const ensure = (name: string) => {
		let inst = instances.get(name);
		if (!inst) {
			const ctx = makeCtx();
			ctxs.push(ctx);
			// biome-ignore lint/suspicious/noExplicitAny: stub ctx/env
			inst = new AttachHub(ctx as any, {} as any);
			instances.set(name, inst);
		}
		return inst;
	};
	const namespace = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => {
			const inst = ensure(id.name);
			return {
				fetch: (req: Request) => inst.fetch(req),
				list: (principalId: string) => inst.list(principalId),
			};
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: fake namespace
	const relay = createDurableObjectAttachHub(namespace as any);
	// biome-ignore lint/suspicious/noExplicitAny: fake namespace
	const reader = createDurableObjectHostDirectory(namespace as any);
	const settle = () => Promise.all(ctxs.map((c) => c.drain()));
	return { relay, reader, settle };
}

/**
 * An upgrade descriptor as the mount produces it: `principalId` is the
 * server-resolved (authoritative) value, while the connect-query `principalId`
 * is a bogus client claim, so a passing test also proves the registry stamps the
 * resolved principal over the query.
 */
function upgrade(params: {
	role: 'host' | 'client';
	principalId: string;
	hostId: string;
	deviceId?: string;
	attachId?: string;
	label?: string;
}) {
	const url = new URL('https://cloud.example/attach');
	url.searchParams.set('role', params.role);
	url.searchParams.set('principalId', 'query-claims-someone-else');
	url.searchParams.set('hostId', params.hostId);
	if (params.deviceId) url.searchParams.set('deviceId', params.deviceId);
	if (params.attachId) url.searchParams.set('attachId', params.attachId);
	if (params.label) url.searchParams.set('label', params.label);
	const request = new Request(url, {
		headers: {
			Upgrade: 'websocket',
			'sec-websocket-protocol': 'epicenter, bearer.tok',
		},
	});
	return {
		request,
		principalId: params.principalId,
		role: params.role,
		hostId: params.hostId,
		deviceId: params.deviceId,
		attachId: params.attachId,
		label: params.label,
	};
}

/** The stub pair minted for the Nth accepted upgrade, or throw if none. */
function pairAt(index: number): {
	client: StubWebSocket;
	server: StubWebSocket;
} {
	const pair = webSocketPairs[index];
	if (!pair) throw new Error(`no web socket pair at index ${index}`);
	return pair;
}

function frameMatches(frame: string, fields: Record<string, unknown>): boolean {
	let value: unknown;
	try {
		value = JSON.parse(frame);
	} catch {
		return false;
	}
	if (value === null || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return Object.entries(fields).every(([key, want]) => record[key] === want);
}

describe('AttachHub Durable Object backend: relay transport', () => {
	test('host and client of one principal share a hub and exchange live bytes', async () => {
		webSocketPairs.length = 0;
		const { relay } = await makeHub();

		const hostResponse = await relay.handleUpgrade(
			upgrade({ role: 'host', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		expect(hostResponse.status).toBe(101);
		const host = pairAt(0);
		expect(host.server.accepted).toBe(true);

		await relay.handleUpgrade(
			upgrade({
				role: 'client',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				deviceId: 'phone',
				attachId: 'attach-1',
			}),
		);
		const phone = pairAt(1);

		// The host saw the phone attach: the coordinator forwarded a lifecycle event
		// onto the host's server socket. This only fires if both sockets landed on
		// ONE hub, which in turn requires the registry to have stamped PRINCIPAL_A
		// (the query claimed someone else).
		expect(
			host.server.sent.some((f) =>
				frameMatches(f, {
					deviceId: 'phone',
					attachId: 'attach-1',
					event: 'attach',
				}),
			),
		).toBe(true);

		// Phone -> host: the client's opaque bytes reach the host stamped with its
		// source endpoint.
		phone.client.send('session-command-from-phone');
		expect(
			host.server.sent.some((f) =>
				frameMatches(f, {
					deviceId: 'phone',
					attachId: 'attach-1',
					payload: 'session-command-from-phone',
				}),
			),
		).toBe(true);

		// Host -> phone: the host addresses the one client endpoint; the relay
		// delivers the opaque payload to that socket.
		host.client.send(
			JSON.stringify({
				deviceId: 'phone',
				attachId: 'attach-1',
				payload: 'snapshot-for-phone',
			}),
		);
		expect(phone.server.sent).toContain('snapshot-for-phone');
	});

	test("account B's client cannot reach account A's host: routed to another hub", async () => {
		webSocketPairs.length = 0;
		const { relay } = await makeHub();

		await relay.handleUpgrade(
			upgrade({ role: 'host', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		const host = pairAt(0);

		// Same hostId, but the server-resolved principal is B: a different hub name,
		// so a different (empty) actor, so no live host to pair with.
		await relay.handleUpgrade(
			upgrade({
				role: 'client',
				principalId: PRINCIPAL_B,
				hostId: HOST_ID,
				deviceId: 'attacker-phone',
				attachId: 'attach-x',
			}),
		);
		const attacker = pairAt(1);

		expect(attacker.server.closes[0]?.code).toBe(RELAY_CLOSE.HOST_NOT_FOUND);
		expect(host.server.sent.some((f) => f.includes('attacker-phone'))).toBe(
			false,
		);
	});

	test('a non-upgrade request is refused, no socket is minted', async () => {
		webSocketPairs.length = 0;
		const { relay } = await makeHub();
		const request = new Request(
			'https://cloud.example/attach?role=host&principalId=x&hostId=h',
		);
		const response = await relay.handleUpgrade({
			request,
			principalId: PRINCIPAL_A,
			role: 'host',
			hostId: HOST_ID,
			deviceId: undefined,
			attachId: undefined,
		});
		expect(response.status).toBe(405);
		expect(webSocketPairs.length).toBe(0);
	});

	test('a client missing its endpoint ids is a 400, before any hub socket', async () => {
		webSocketPairs.length = 0;
		const { relay } = await makeHub();
		// role=client but no deviceId/attachId: an incomplete endpoint shape.
		const response = await relay.handleUpgrade(
			upgrade({ role: 'client', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		expect(response.status).toBe(400);
		expect(webSocketPairs.length).toBe(0);
	});
});

describe('AttachHub Durable Object backend: host discovery', () => {
	test('a host lists online while live and offline after it closes', async () => {
		webSocketPairs.length = 0;
		const { relay, reader, settle } = await makeHub();

		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				label: LABEL,
			}),
		);
		await settle();

		// Online while the host socket is registered, joined against the live socket
		// set in the same actor. This also proves the hub recorded PRINCIPAL_A's
		// membership (the query claimed someone else).
		expect(await reader.list(PRINCIPAL_A)).toEqual([
			{ hostId: HOST_ID, label: LABEL, status: 'online' },
		]);

		// The host socket closes; membership is retained, not dropped, and the
		// coordinator drops the live host, so the join now renders offline.
		pairAt(0).server.close(1000, 'bye');
		await settle();
		expect(await reader.list(PRINCIPAL_A)).toEqual([
			{ hostId: HOST_ID, label: LABEL, status: 'offline' },
		]);
	});

	test('a host with no label falls back to its hostId', async () => {
		webSocketPairs.length = 0;
		const { relay, reader, settle } = await makeHub();

		await relay.handleUpgrade(
			upgrade({ role: 'host', principalId: PRINCIPAL_A, hostId: HOST_ID }),
		);
		await settle();

		expect(await reader.list(PRINCIPAL_A)).toEqual([
			{ hostId: HOST_ID, label: HOST_ID, status: 'online' },
		]);
	});

	test("account B never reads account A's hosts (per-principal partition)", async () => {
		webSocketPairs.length = 0;
		const { relay, reader, settle } = await makeHub();

		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				label: LABEL,
			}),
		);
		await settle();

		// B's hub has a different name, so it is a different (empty) actor.
		expect(await reader.list(PRINCIPAL_B)).toEqual([]);
	});

	test('a refused second host keeps the incumbent online and its label', async () => {
		webSocketPairs.length = 0;
		const { relay, reader, settle } = await makeHub();

		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				label: LABEL,
			}),
		);
		// A conflicting second host on the same id: the coordinator refuses it
		// (HOST_CONFLICT) and its socket closes immediately. It never won
		// registration, so it never recorded membership; the incumbent keeps both
		// its `online` and its label.
		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				label: 'Mac (stale reconnect)',
			}),
		);
		pairAt(1).server.close(4409, 'host already registered');
		await settle();

		expect(await reader.list(PRINCIPAL_A)).toEqual([
			{ hostId: HOST_ID, label: LABEL, status: 'online' },
		]);
	});

	test('two distinct hosts of one principal both list', async () => {
		webSocketPairs.length = 0;
		const { relay, reader, settle } = await makeHub();

		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: 'mac',
				label: 'Mac',
			}),
		);
		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: 'linux',
				label: 'Linux',
			}),
		);
		await settle();

		// One hub holds many hosts of the principal; both are live and list online.
		expect(await reader.list(PRINCIPAL_A)).toEqual(
			expect.arrayContaining([
				{ hostId: 'mac', label: 'Mac', status: 'online' },
				{ hostId: 'linux', label: 'Linux', status: 'online' },
			]),
		);
		expect((await reader.list(PRINCIPAL_A)).length).toBe(2);
	});

	test('every listed entry parses under the closed schema', async () => {
		webSocketPairs.length = 0;
		const { relay, reader, settle } = await makeHub();

		await relay.handleUpgrade(
			upgrade({
				role: 'host',
				principalId: PRINCIPAL_A,
				hostId: HOST_ID,
				label: LABEL,
			}),
		);
		await settle();

		const entries = await reader.list(PRINCIPAL_A);
		for (const entry of entries) {
			// The reader emits only `{ hostId, label, status }`; the closed schema
			// (`.onUndeclaredKey('reject')`) accepts it and would reject any extra
			// route/capability/action/tool field.
			expect(AttachHostDirectoryEntry(entry) instanceof type.errors).toBe(
				false,
			);
		}
	});
});
