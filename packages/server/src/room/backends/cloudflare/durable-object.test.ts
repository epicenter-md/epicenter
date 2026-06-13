/**
 * `Room` Durable Object tests.
 *
 * Exercises the relay's two WebSocket wire surfaces through the live `Room`:
 *
 * Presence: the relay broadcasts one `presence` text frame carrying the
 * FULL device list on every connection change. Covers the directed frame
 * on upgrade, the first-socket rebroadcast, multi-tab dedup (the list is
 * unchanged so no rebroadcast), the debounced rebroadcast on last-socket
 * close, graceful handoff cancellation, the 4401 grace bypass, and
 * broadcast resilience against wedged sockets.
 *
 * Binary sync: a y-protocols update from one socket fans out to peer
 * sockets but not its origin, and a malformed binary frame is logged
 * rather than thrown out of the message handler.
 *
 * Bun's test runtime does not provide Cloudflare Workers globals, so we
 * mock `cloudflare:workers` (DurableObject base class), shim
 * `WebSocketPair` / `WebSocket`, and drive the Room via its public
 * `fetch()` and `webSocketClose()` overrides directly.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
	encodeSyncRequest,
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

// ────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS SHIMS
// ────────────────────────────────────────────────────────────────────────────

// `WebSocket` is a host global in real Workers but Bun ships its own
// WebSocket class without a `WebSocketPair`. Provide a minimal stub good
// enough for the Room's send/close/readyState surface.
class StubWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = StubWebSocket.OPEN;
	sent: Array<Uint8Array | string> = [];
	closeCalls: Array<{ code: number; reason: string }> = [];
	private attachment: unknown = null;
	private failOnSend = false;

	send(data: Uint8Array | string): void {
		if (this.failOnSend) throw new Error('wedged');
		if (this.readyState !== StubWebSocket.OPEN) {
			throw new Error('socket not open');
		}
		this.sent.push(data);
	}

	close(code: number, reason: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = StubWebSocket.CLOSED;
	}

	serializeAttachment(value: unknown): void {
		this.attachment = value;
	}

	deserializeAttachment(): unknown {
		return this.attachment;
	}

	// Test-only: simulate a wedged peer whose `send` always throws.
	__wedge(): void {
		this.failOnSend = true;
	}

	// Test-only: pull text frames out of `sent`.
	textFrames(): string[] {
		return this.sent.filter((f): f is string => typeof f === 'string');
	}
}

class StubWebSocketPair {
	0: StubWebSocket;
	1: StubWebSocket;
	constructor() {
		this[0] = new StubWebSocket();
		this[1] = new StubWebSocket();
	}
}

// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocket ??= StubWebSocket;
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketPair ??= StubWebSocketPair;

// `cloudflare:workers` is not resolvable in Bun. Mock it with a barebones
// DurableObject base class that records `ctx` and `env` so Room's
// constructor can run.
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
// DURABLE OBJECT CTX STUB
// ────────────────────────────────────────────────────────────────────────────

type SqlRow = { id: number; data: ArrayBuffer };

/**
 * In-memory SQL surface that satisfies the subset of `ctx.storage.sql`
 * the Room touches: schema DDL, SELECT all updates, INSERT, DELETE,
 * COUNT, and `databaseSize`.
 */
function makeSqlStorage() {
	const updates: SqlRow[] = [];
	let nextId = 1;
	// Models the `room_tombstone` table as a single boolean: destruction writes
	// one row, `isDestroyed()` counts it. Kept separate from `updates` so the
	// two COUNT queries route by table name, not by accident.
	let tombstoned = false;

	function exec(
		query: string,
		...params: unknown[]
	): { toArray(): SqlRow[]; one(): { count: number } } {
		const q = query.trim().toUpperCase();
		if (q.startsWith('CREATE TABLE')) {
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.includes('ROOM_TOMBSTONE')) {
			if (q.startsWith('SELECT COUNT')) {
				return {
					toArray: () => [],
					one: () => ({ count: tombstoned ? 1 : 0 }),
				};
			}
			if (q.startsWith('INSERT')) {
				tombstoned = true;
				return { toArray: () => [], one: () => ({ count: 0 }) };
			}
			throw new Error(`Unsupported SQL: ${query}`);
		}
		if (q.startsWith('SELECT DATA FROM UPDATES')) {
			return {
				toArray: () => [...updates],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('SELECT COUNT(*)')) {
			return {
				toArray: () => [],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('INSERT INTO UPDATES')) {
			const blob = params[0] as Uint8Array;
			const copy = new ArrayBuffer(blob.byteLength);
			new Uint8Array(copy).set(blob);
			updates.push({ id: nextId++, data: copy });
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('DELETE FROM UPDATES')) {
			updates.length = 0;
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		throw new Error(`Unsupported SQL: ${query}`);
	}

	return {
		exec,
		get databaseSize() {
			return updates.reduce((acc, r) => acc + r.data.byteLength, 0);
		},
		transactionSync(fn: () => void) {
			fn();
		},
	};
}

function makeStorage() {
	let alarm: number | null = null;
	return {
		sql: makeSqlStorage(),
		// `transactionSync` lives on `ctx.storage` (DurableObjectStorage) in the
		// real runtime, not on `ctx.storage.sql`. `update-log` replaceAll and
		// `Room.destroy` both call it there.
		transactionSync<T>(fn: () => T): T {
			return fn();
		},
		async setAlarm(when: number) {
			alarm = when;
		},
		async getAlarm() {
			return alarm;
		},
		async deleteAlarm() {
			alarm = null;
		},
		async deleteAll() {},
	};
}

type StubCtx = {
	storage: ReturnType<typeof makeStorage>;
	acceptedSockets: StubWebSocket[];
	acceptWebSocket(ws: StubWebSocket): void;
	getWebSockets(): StubWebSocket[];
	blockConcurrencyWhile(fn: () => Promise<unknown>): Promise<void>;
	setWebSocketAutoResponse(_pair: unknown): void;
};

function makeCtx(): StubCtx {
	const acceptedSockets: StubWebSocket[] = [];
	return {
		storage: makeStorage(),
		acceptedSockets,
		acceptWebSocket(ws: StubWebSocket) {
			acceptedSockets.push(ws);
		},
		getWebSockets() {
			return acceptedSockets.slice();
		},
		async blockConcurrencyWhile(fn: () => Promise<unknown>) {
			await fn();
		},
		setWebSocketAutoResponse(_pair: unknown) {},
	};
}

// `WebSocketRequestResponsePair` is a global constructor in real Workers.
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketRequestResponsePair ??= class {
	constructor(_a: string, _b: string) {}
};

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Room exposes typed CF surfaces
// (DurableObject, WebSocket) we are stubbing; cast to keep tests pragmatic.
type RoomLike = any;

async function makeRoom(): Promise<{ room: RoomLike; ctx: StubCtx }> {
	// Dynamic import so the cloudflare:workers mock is in place.
	const { Room } = await import('./durable-object.js');
	const ctx = makeCtx();
	// biome-ignore lint/suspicious/noExplicitAny: env unused in our scenarios
	const room = new Room(ctx as any, {} as any) as RoomLike;
	// blockConcurrencyWhile is fire-and-forget in real CF; await readiness here.
	await Promise.resolve();
	return { room, ctx };
}

function upgradeRequest(deviceId: string, userId = 'user-test'): Request {
	return new Request(
		`https://relay.test/?userId=${userId}&deviceId=${deviceId}`,
		{
			method: 'GET',
			headers: {
				Upgrade: 'websocket',
				'sec-websocket-protocol': 'epicenter',
			},
		},
	);
}

/** Drive an upgrade end-to-end and return the server-side socket. */
async function upgrade(
	room: RoomLike,
	deviceId: string,
	userId = 'user-test',
): Promise<StubWebSocket> {
	const response = await room.fetch(upgradeRequest(deviceId, userId));
	expect(response.status).toBe(101);
	// In real CF the response carries the CLIENT socket on `response.webSocket`;
	// Bun's `Response` ignores the field but the server socket is the
	// most-recently `acceptWebSocket`'d one.
	const ctx = room.ctx as StubCtx;
	const serverSocket = ctx.acceptedSockets[ctx.acceptedSockets.length - 1]!;
	return serverSocket;
}

type WireDevice = {
	deviceId: string;
	connectedAt: number;
	actions: Record<string, unknown>;
};
type PresenceFrame = { type: 'presence'; devices: WireDevice[] };

/** Parse text frames of a given `type` off the wire. */
function jsonFrames(
	ws: StubWebSocket,
	type: string,
): Array<Record<string, unknown>> {
	return ws
		.textFrames()
		.map((t) => {
			try {
				return JSON.parse(t) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((f): f is Record<string, unknown> => f !== null && f.type === type);
}

/** Parse all `presence` text frames out of the wire. */
function presenceFrames(ws: StubWebSocket): PresenceFrame[] {
	return jsonFrames(ws, 'presence').filter((p): p is PresenceFrame =>
		Array.isArray((p as { devices?: unknown }).devices),
	);
}

/** Project a presence frame down to just its deviceIds, for assertions
 *  that don't care about connectedAt timestamps or action manifests. */
function deviceIds(frame: PresenceFrame): string[] {
	return frame.devices.map((d) => d.deviceId);
}

/** Wrap a frame as the `ArrayBuffer` `webSocketMessage` expects for binary input. */
function toArrayBuffer(frame: Uint8Array): ArrayBuffer {
	return frame.slice().buffer;
}

/** A well-formed binary sync frame: sync sub-type varint + payload. */
function frameWithSyncType(
	syncType: number,
	payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, syncType);
		encoding.writeVarUint8Array(enc, payload);
	});
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('Room presence: directed frame on upgrade', () => {
	test('first socket receives an empty device list', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		expect(presenceFrames(ws).map(deviceIds)).toEqual([[]]);
	});

	test('second device upgrade sees the first device in its directed frame', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		expect(presenceFrames(ws).map(deviceIds)).toEqual([['A']]);
	});

	test('directed frame to a new tab excludes the receiver own device', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		await upgrade(room, 'B');
		const ws = await upgrade(room, 'A'); // second A tab
		// The new tab's only frame is the directed one; it lists B, not A.
		expect(deviceIds(presenceFrames(ws)[0]!)).toEqual(['B']);
	});

	test('directed frame entries include connectedAt and an empty actions manifest by default', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		const [frame] = presenceFrames(ws);
		expect(frame).toBeDefined();
		const [deviceA] = frame!.devices;
		expect(deviceA).toBeDefined();
		expect(deviceA!.deviceId).toBe('A');
		expect(typeof deviceA!.connectedAt).toBe('number');
		expect(deviceA!.actions).toEqual({});
	});
});

describe('Room presence: first-socket rebroadcast', () => {
	test('first socket for a device rebroadcasts the list to existing peers', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const before = presenceFrames(wsA).length;
		await upgrade(room, 'B');
		const after = presenceFrames(wsA).slice(before);
		expect(after.map(deviceIds)).toEqual([['B']]);
	});

	test('subsequent socket for the SAME device does NOT rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		await upgrade(room, 'B'); // first B socket: rebroadcast to A
		const beforeSecondTab = presenceFrames(wsA).length;
		await upgrade(room, 'B'); // second B tab: list unchanged, no rebroadcast
		expect(presenceFrames(wsA).slice(beforeSecondTab)).toEqual([]);
	});
});

describe('Room presence: rebroadcast on close', () => {
	test('last socket close debounces a rebroadcast that fires after grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const beforeClose = presenceFrames(wsA).length;
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// Immediately after close: nothing yet (debounce armed).
		expect(presenceFrames(wsA).slice(beforeClose)).toEqual([]);

		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(beforeClose).map(deviceIds)).toEqual([[]]);
	});

	test('intermediate socket close (multi-tab) emits NO rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		await upgrade(room, 'B'); // second B tab keeps the device alive
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsB1, 1000, 'bye', true);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(before)).toEqual([]);
	});
});

describe('Room presence: graceful handoff', () => {
	test('cancel-then-replace: T1 closes, T2 connects inside grace, T2 closes outside grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		const baseline = presenceFrames(wsA).length;

		await room.webSocketClose(wsB1, 1000, 'tab handoff', true);
		await new Promise((r) => setTimeout(r, 100));
		const wsB2 = await upgrade(room, 'B');
		// Past the original grace window from B1's close:
		await new Promise((r) => setTimeout(r, 350));

		// No "B gone" frame: the replacement cancelled the debounce.
		for (const frame of presenceFrames(wsA).slice(baseline)) {
			expect(deviceIds(frame)).toContain('B');
		}

		// Now close B2 with no replacement.
		const afterMid = presenceFrames(wsA).length;
		await room.webSocketClose(wsB2, 1000, 'gone', true);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(afterMid).map(deviceIds)).toEqual([[]]);
	});
});

describe('Room presence: hibernation/wake', () => {
	test('connections survive a fresh DO construction with the same ctx', async () => {
		// Simulate hibernation by constructing a second `Room` that shares
		// `ctx.getWebSockets()`. The new Room must rebuild `connections`
		// from the surviving sockets without emitting spurious presence
		// transitions to them.
		const { Room } = await import('./durable-object.js');
		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r1 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		await upgrade(r1, 'A');
		await upgrade(r1, 'B');

		// Build a "woken" Room reusing the same accepted sockets.
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r2 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		// A new upgrade post-wake should see both A and B in its directed frame.
		const wsC = await upgrade(r2, 'C');
		expect(deviceIds(presenceFrames(wsC)[0]!)).toEqual(['A', 'B']);
	});
});

describe('Room presence: 4401 bypasses grace', () => {
	test('close code 4401 rebroadcasts immediately', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const before = presenceFrames(wsA).length;

		await room.webSocketClose(wsB, 4401, 'auth expired', false);
		// No grace wait.
		expect(presenceFrames(wsA).slice(before).map(deviceIds)).toEqual([[]]);
	});

	test('close code 4401 cancels a pending debounced rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const wsC = await upgrade(room, 'C');

		// B's close arms the debounced rebroadcast timer.
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// C's 4401 close rebroadcasts immediately and must cancel B's pending
		// timer so A sees exactly one frame, not a later double-fire.
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsC, 4401, 'auth expired', false);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(before).map(deviceIds)).toEqual([[]]);
	});
});

describe('Room presence: broadcast resilience', () => {
	test('a wedged socket does not abort the rebroadcast loop', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		// Wedge A so future `send` calls throw.
		wsA.__wedge();

		// Trigger a rebroadcast by connecting a third device.
		const wsC = await upgrade(room, 'C');

		// A's wedged socket recorded nothing past wedging, but B must have
		// received a rebroadcast listing C.
		const bFrames = presenceFrames(wsB);
		expect(deviceIds(bFrames[bFrames.length - 1]!)).toContain('C');

		// C's own directed frame saw A and B (sent before any wedged send).
		expect(deviceIds(presenceFrames(wsC)[0]!)).toEqual(['A', 'B']);
	});
});

describe('Room sync: binary update fan-out', () => {
	test('STEP1 frames receive a STEP2 reply', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		const replies = ws.sent
			.slice(before)
			.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('an update from one socket reaches peers but not its origin', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');

		const beforeA = wsA.sent.length;
		const beforeB = wsB.sent.length;

		// wsA sends a sync UPDATE frame carrying fresh doc state.
		const source = new Y.Doc();
		source.getMap('data').set('hello', 'world');
		const frame = encodeSyncUpdate({
			update: Y.encodeStateAsUpdateV2(source),
		});
		await room.webSocketMessage(wsA, toArrayBuffer(frame));

		// The peer receives one new binary frame; the origin receives none.
		const newBinary = (ws: StubWebSocket, before: number) =>
			ws.sent.slice(before).filter((f) => f instanceof Uint8Array);
		expect(newBinary(wsB, beforeB).length).toBe(1);
		expect(newBinary(wsA, beforeA).length).toBe(0);
	});

	test('truncated frames are caught without throwing out of the handler', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;
		const truncated = new Uint8Array([SYNC_MESSAGE_TYPE.UPDATE, 10]);

		await room.webSocketMessage(ws, toArrayBuffer(truncated));

		// Handler swallows the decode error: no response, no close.
		// (Whether it logs and via which logger is implementation detail.)
		expect(ws.sent.slice(before)).toEqual([]);
		expect(ws.closeCalls).toEqual([]);
	});

	test('decodable out-of-range sync sub-types are no-ops', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;

		await room.webSocketMessage(ws, toArrayBuffer(frameWithSyncType(99)));

		expect(ws.sent.slice(before)).toEqual([]);
		expect(ws.closeCalls).toEqual([]);
	});
});

describe('Room connection lifetime', () => {
	test('a socket past the max lifetime is closed with the reconnect code and its frame is dropped', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;
		// Age the connection past MAX_CONNECTION_LIFETIME_MS (30 min) by
		// rewriting connectedAt on the stored attachment.
		const attachment = ws.deserializeAttachment() as { connectedAt: number };
		ws.serializeAttachment({
			...attachment,
			connectedAt: Date.now() - 31 * 60_000,
		});

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		// Closed with the transient reconnect code (not the permanent 4401),
		// and the STEP1 produced no STEP2 reply because the frame was dropped.
		expect(ws.closeCalls.map((c) => c.code)).toEqual([4408]);
		expect(ws.sent.slice(before)).toEqual([]);
	});

	test('a fresh socket is served normally and not closed', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		expect(ws.closeCalls).toEqual([]);
	});

	test('the alarm sweep closes an idle over-age socket with no inbound frame', async () => {
		const { room } = await makeRoom();
		const wsOld = await upgrade(room, 'A');
		const wsFresh = await upgrade(room, 'B');
		// Age wsOld past the lifetime; it never sends a frame (the idle case the
		// per-message check cannot catch).
		const attachment = wsOld.deserializeAttachment() as { connectedAt: number };
		wsOld.serializeAttachment({
			...attachment,
			connectedAt: Date.now() - 31 * 60_000,
		});

		await room.alarm();

		expect(wsOld.closeCalls.map((c) => c.code)).toEqual([4408]);
		expect(wsFresh.closeCalls).toEqual([]);
	});
});

describe('Room sync: HTTP sync RPC', () => {
	test('a malformed sync body resolves to Err(MalformedSyncBody)', async () => {
		const { room } = await makeRoom();
		// A length prefix claiming 10 payload bytes that are not present:
		// lib0 readVarUint8Array underflows inside decodeSyncRequest.
		const { error } = await room.sync(new Uint8Array([10]));

		expect(error?.name).toBe('MalformedSyncBody');
	});
});

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

describe('Room dispatch: relay round trip', () => {
	test('dispatch_request routes dispatch_inbound to the recipient', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd1',
				to: 'recipient',
				action: 'noop_ping',
				input: { x: 1 },
			}),
		);

		const inbound = jsonFrames(recipientWs, 'dispatch_inbound');
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({
			id: 'd1',
			action: 'noop_ping',
			input: { x: 1 },
		});
	});

	test('dispatch_response routes a dispatch_result back to the caller', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd2',
				to: 'recipient',
				action: 'noop_ping',
			}),
		);
		await room.webSocketMessage(
			recipientWs,
			JSON.stringify({
				type: 'dispatch_response',
				id: 'd2',
				result: { data: 'pong', error: null },
			}),
		);

		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd2',
			result: { data: 'pong', error: null },
		});
	});

	test('dispatch_response from a non-recipient socket is ignored', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');
		const impostorWs = await upgrade(room, 'impostor');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd3',
				to: 'recipient',
				action: 'noop_ping',
			}),
		);
		// A peer that is not the dispatch target cannot forge the result, even
		// if it learns the id.
		await room.webSocketMessage(
			impostorWs,
			JSON.stringify({
				type: 'dispatch_response',
				id: 'd3',
				result: { data: 'spoofed', error: null },
			}),
		);
		expect(jsonFrames(callerWs, 'dispatch_result')).toHaveLength(0);

		// The real recipient still resolves it: the pending entry survived the
		// impostor.
		await room.webSocketMessage(
			recipientWs,
			JSON.stringify({
				type: 'dispatch_response',
				id: 'd3',
				result: { data: 'pong', error: null },
			}),
		);
		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd3',
			result: { data: 'pong', error: null },
		});
	});
});

describe('Room dispatch: recipient offline', () => {
	test('no live socket for `to`: immediate RecipientOffline result', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd3',
				to: 'ghost',
				action: 'noop_ping',
			}),
		);

		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd3',
			result: { error: { name: 'RecipientOffline', to: 'ghost' } },
		});
	});

	test('recipient socket closing mid-dispatch fails the caller', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd4',
				to: 'recipient',
				action: 'noop_ping',
			}),
		);
		await room.webSocketClose(recipientWs, 1000, 'bye', true);

		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd4',
			result: { error: { name: 'RecipientOffline' } },
		});
	});
});

describe('Room dispatch: malformed frames', () => {
	test('a dispatch_request missing fields is dropped, the socket stays open', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({ type: 'dispatch_request', id: 'd5' }),
		);

		expect(callerWs.closeCalls).toHaveLength(0);
		expect(jsonFrames(callerWs, 'dispatch_result')).toHaveLength(0);
	});

	test('an unknown text frame type closes the socket with 4400', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({ type: 'totally_bogus' }),
		);

		expect(callerWs.closeCalls).toHaveLength(1);
		expect(callerWs.closeCalls[0]?.code).toBe(4400);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// DESTROY (tombstone)
// ────────────────────────────────────────────────────────────────────────────

/** HTTP sync body carrying a single `{ m: { k: 'v' } }` update. */
function populateSyncBody(): Uint8Array {
	const src = new Y.Doc();
	src.getMap('m').set('k', 'v');
	return encodeSyncRequest(
		Y.encodeStateVector(new Y.Doc()),
		Y.encodeStateAsUpdateV2(src),
	);
}

/** Decode a room's current doc state into a fresh Y.Doc for assertions. */
async function readRoomValue(room: RoomLike): Promise<unknown> {
	const doc = new Y.Doc();
	Y.applyUpdateV2(doc, (await room.getDoc()).data);
	return doc.getMap('m').get('k');
}

describe('destroy', () => {
	test('empties the doc and refuses resurrection from a racing sync', async () => {
		const { room } = await makeRoom();
		await room.sync(populateSyncBody());
		expect(await readRoomValue(room)).toBe('v');

		await room.destroy();

		// getDoc exposes an empty snapshot, never the lingering in-memory doc.
		expect(await readRoomValue(room)).toBeUndefined();

		// A client that still held the doc and re-pushes it is discarded.
		const res = await room.sync(populateSyncBody());
		expect(res.error).toBeNull();
		expect(res.data.diff).toBeNull();
		expect(await readRoomValue(room)).toBeUndefined();
	});

	test('refuses new WebSocket upgrades with 410', async () => {
		const { room } = await makeRoom();
		await room.destroy();
		const res = await room.fetch(upgradeRequest('dev-1'));
		expect(res.status).toBe(410);
	});

	test('closes live sockets with the permanent room-gone code', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'dev-1');
		await room.destroy();
		expect(ws.closeCalls.some((c) => c.code === 4410)).toBe(true);
	});

	test('close + alarm after destroy do not resurrect via compaction', async () => {
		const { room, ctx } = await makeRoom();
		const ws = await upgrade(room, 'dev-1');
		await room.sync(populateSyncBody());
		await room.destroy();

		// The runtime still delivers the close, then fires the pending alarm. A
		// non-destroyed room would arm + run compaction, re-encoding the in-memory
		// doc back into the emptied log. The destroyed room must do neither.
		await room.webSocketClose(ws, 1000, 'bye', true);
		await room.alarm();

		expect(await readRoomValue(room)).toBeUndefined();
		expect(await ctx.storage.getAlarm()).toBeNull();
	});

	test('a reconstructed room stays destroyed (tombstone persists)', async () => {
		const { room, ctx } = await makeRoom();
		await room.sync(populateSyncBody());
		await room.destroy();

		// Cold start: a fresh Room over the SAME persisted storage must read the
		// tombstone synchronously in its constructor and refuse from the start.
		const { Room } = await import('./durable-object.js');
		const ctx2 = makeCtx();
		ctx2.storage = ctx.storage;
		const room2 = new Room(ctx2 as never, {} as never) as RoomLike;
		await Promise.resolve();

		const res = await room2.sync(populateSyncBody());
		expect(res.data.diff).toBeNull();
		expect(await readRoomValue(room2)).toBeUndefined();
	});
});
