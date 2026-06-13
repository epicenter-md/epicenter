/**
 * Doc-as-wire generation actor tests.
 *
 * Drives {@link runDocGeneration} against a real `createRoomCore` (the
 * runtime-agnostic room the Durable Object wraps) with fake provider
 * streams. The room core IS the second replica: every assertion about the
 * post-run transcript reads the room's doc back through `getDoc()`, so a
 * passing test proves the actor's incremental flush updates apply cleanly
 * on the receiving side.
 */

import { describe, expect, test } from 'bun:test';
import { encodeSyncRequest } from '@epicenter/sync';
import {
	appendAssistantMessage,
	appendUserMessage,
	readChatDocMessages,
} from '@epicenter/workspace/ai';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import type { RoomUpdateLog } from '../room/contracts.js';
import { createRoomCore } from '../room/core.js';
import { runDocGeneration } from './doc-generation.js';

// ────────────────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────────────────

function createMemoryUpdateLog(): RoomUpdateLog {
	let entries: Uint8Array[] = [];
	return {
		loadAll: () => entries,
		append: (update) => {
			entries.push(update);
		},
		clear: () => {
			entries = [];
		},
		replaceAll: (compacted) => {
			entries = [compacted];
		},
		byteSize: () => entries.reduce((sum, u) => sum + u.byteLength, 0),
		entryCount: () => entries.length,
	};
}

function createHarness() {
	const core = createRoomCore({ updateLog: createMemoryUpdateLog() });
	const waited: Promise<unknown>[] = [];
	return {
		core,
		/** The `ResolvedRoom` slice the actor consumes, over the live core. */
		room: {
			getDoc: async () => core.getDoc(),
			sync: async (body: Uint8Array) => core.sync(body),
		},
		waited,
		waitUntil: (promise: Promise<unknown>) => {
			waited.push(promise);
		},
		/** Apply a client-authored doc state to the room, like a synced peer. */
		seed(build: (doc: Y.Doc) => void) {
			const doc = new Y.Doc({ gc: true });
			build(doc);
			const result = core.sync(
				encodeSyncRequest(
					Y.encodeStateVector(doc),
					Y.encodeStateAsUpdateV2(doc),
				),
			);
			expect(result.error).toBeNull();
			doc.destroy();
		},
		/** Read the room's transcript back through a fresh replica. */
		messages() {
			const doc = new Y.Doc({ gc: true });
			Y.applyUpdateV2(doc, core.getDoc().data);
			const messages = readChatDocMessages(doc);
			doc.destroy();
			return messages;
		},
	};
}

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'message-1',
		delta,
	} as StreamChunk;
}

async function* streamOf(...deltas: string[]): AsyncGenerator<StreamChunk> {
	for (const delta of deltas) yield textChunk(delta);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('runDocGeneration', () => {
	test('streams a turn into the room: appends one assistant message, finish completed', async () => {
		const harness = createHarness();
		harness.seed((doc) =>
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 }),
		);

		let prompt: ModelMessage[] | undefined;
		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: (messages) => {
				prompt = messages;
				return streamOf('你', '好', '!');
			},
		});

		expect(result.error).toBeNull();
		expect(result.data?.finish).toEqual({ kind: 'completed' });
		expect(prompt).toEqual([{ role: 'user', content: 'hi' }]);

		const messages = harness.messages();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ id: 'u1', role: 'user', text: 'hi' });
		expect(messages[1]).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: '你好!',
			finish: { kind: 'completed' },
		});
	});

	test('multi-flush turn (slow stream) converges on the room replica', async () => {
		const harness = createHarness();
		harness.seed((doc) =>
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 }),
		);

		async function* slowStream(): AsyncGenerator<StreamChunk> {
			for (const delta of ['alpha ', 'beta ', 'gamma']) {
				yield textChunk(delta);
				await sleep(90); // past FLUSH_INTERVAL_MS so each chunk flushes
			}
		}

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => slowStream(),
		});

		expect(result.error).toBeNull();
		expect(harness.messages().at(-1)?.text).toBe('alpha beta gamma');
	});

	test('replayed generationId returns GenerationAlreadyExists and writes nothing', async () => {
		const harness = createHarness();
		harness.seed((doc) => {
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 });
			const writer = appendAssistantMessage(doc, {
				id: 'gen-1',
				createdAt: 2000,
			});
			writer.appendText('done already');
			writer.finish({ kind: 'completed' });
		});
		const before = harness.messages();

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => streamOf('should never run'),
		});

		expect(result.error?.name).toBe('GenerationAlreadyExists');
		expect(harness.messages()).toEqual(before);
	});

	test('recent unfinished trailing assistant blocks with GenerationInProgress', async () => {
		const harness = createHarness();
		harness.seed((doc) => {
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 });
			appendAssistantMessage(doc, { id: 'gen-live', createdAt: Date.now() });
		});
		const before = harness.messages();

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-2',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => streamOf('should never run'),
		});

		expect(result.error?.name).toBe('GenerationInProgress');
		expect(harness.messages()).toEqual(before);
	});

	test('stale unfinished trailing assistant is an interrupted artifact and does not block', async () => {
		const harness = createHarness();
		const staleCreatedAt = Date.now() - 3 * 60 * 1000;
		harness.seed((doc) => {
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 });
			const writer = appendAssistantMessage(doc, {
				id: 'gen-interrupted',
				createdAt: staleCreatedAt,
			});
			writer.appendText('partial answer');
			// No finish: the worker died mid-generation.
		});

		let prompt: ModelMessage[] | undefined;
		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-2',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: (messages) => {
				prompt = messages;
				return streamOf('fresh answer');
			},
		});

		expect(result.error).toBeNull();
		// The artifact's partial text joins the prompt; the artifact itself
		// is never touched again (still no finish).
		expect(prompt).toEqual([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'partial answer' },
		]);
		const messages = harness.messages();
		expect(messages).toHaveLength(3);
		expect(messages[1]).toMatchObject({
			id: 'gen-interrupted',
			text: 'partial answer',
		});
		expect(messages[1]?.finish).toBeUndefined();
		expect(messages[2]).toMatchObject({
			id: 'gen-2',
			text: 'fresh answer',
			finish: { kind: 'completed' },
		});
	});

	test('conversation without a user message returns NoUserMessage', async () => {
		const harness = createHarness();

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => streamOf('should never run'),
		});

		expect(result.error?.name).toBe('NoUserMessage');
		expect(harness.messages()).toHaveLength(0);
	});

	test('abort mid-stream writes finish cancelled with the flushed prefix, via waitUntil', async () => {
		const harness = createHarness();
		harness.seed((doc) =>
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 }),
		);

		const abortController = new AbortController();
		async function* abortingStream(): AsyncGenerator<StreamChunk> {
			yield textChunk('partial');
			abortController.abort();
			yield textChunk(' never lands');
		}

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: abortController.signal,
			waitUntil: harness.waitUntil,
			startStream: () => abortingStream(),
		});

		expect(result.error).toBeNull();
		expect(result.data?.finish).toEqual({ kind: 'cancelled' });

		// The cancelled-path final sync rides waitUntil; settle it first.
		expect(harness.waited.length).toBeGreaterThan(0);
		await Promise.all(harness.waited);

		const trailing = harness.messages().at(-1);
		expect(trailing).toMatchObject({
			id: 'gen-1',
			text: 'partial',
			finish: { kind: 'cancelled' },
		});
	});

	test('provider RUN_ERROR writes finish failed with code and keeps streamed text', async () => {
		const harness = createHarness();
		harness.seed((doc) =>
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 }),
		);

		async function* erroringStream(): AsyncGenerator<StreamChunk> {
			yield textChunk('partial');
			yield {
				type: EventType.RUN_ERROR,
				message: 'model exploded',
				code: 'provider-overloaded',
			} as StreamChunk;
		}

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => erroringStream(),
		});

		expect(result.error).toBeNull();
		expect(result.data?.finish).toEqual({
			kind: 'failed',
			code: 'provider-overloaded',
			message: 'model exploded',
		});
		expect(harness.messages().at(-1)).toMatchObject({
			text: 'partial',
			finish: { kind: 'failed', code: 'provider-overloaded' },
		});
	});

	test('a rejecting room.sync degrades gracefully: the actor resolves, never throws', async () => {
		const harness = createHarness();
		harness.seed((doc) =>
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 }),
		);

		// A Durable Object RPC rejects (it does not return Err) on isolate
		// eviction or transport failure. The actor must swallow it, keep the
		// held-open request alive, and resolve rather than 500 the route.
		const rejectingRoom = {
			getDoc: harness.room.getDoc,
			sync: async () => {
				throw new Error('durable object unreachable');
			},
		};

		const result = await runDocGeneration({
			room: rejectingRoom,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => streamOf('你好'),
		});

		// Resolves (no throw); the generation completed locally even though no
		// update reached the room.
		expect(result.error).toBeNull();
		expect(result.data?.finish).toEqual({ kind: 'completed' });
	});

	test('a throwing stream (not aborted) writes finish failed with stream-error', async () => {
		const harness = createHarness();
		harness.seed((doc) =>
			appendUserMessage(doc, { id: 'u1', content: 'hi', createdAt: 1000 }),
		);

		async function* throwingStream(): AsyncGenerator<StreamChunk> {
			yield textChunk('partial');
			throw new Error('socket reset');
		}

		const result = await runDocGeneration({
			room: harness.room,
			generationId: 'gen-1',
			signal: new AbortController().signal,
			waitUntil: harness.waitUntil,
			startStream: () => throwingStream(),
		});

		expect(result.error).toBeNull();
		expect(result.data?.finish).toMatchObject({
			kind: 'failed',
			code: 'stream-error',
		});
		expect(harness.messages().at(-1)?.finish).toMatchObject({
			kind: 'failed',
			code: 'stream-error',
		});
	});
});
