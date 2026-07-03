import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachRecords } from '../document/attach-records.js';
import type { AgentEngine, EngineChunk } from './engine.js';
import { createConversation } from './loop.js';
import {
	type AgentMessage,
	agentMessageText,
	isPersistableMessage,
	type ModelMessage,
} from './message.js';
import {
	type AgentToolCall,
	type Approval,
	defaultApprovalDecision,
	type ToolCatalog,
} from './tools.js';

/**
 * A disposable store over an in-memory doc, matching what `docs.open()` returns
 * in an app (the open wrapper adds disposal; `attachRecords` alone does not).
 */
function makeStore() {
	const doc = new Y.Doc();
	const handle = attachRecords<AgentMessage>(doc);
	return Object.assign(handle, {
		[Symbol.dispose]() {
			doc.destroy();
		},
	});
}

function streamOf(chunks: EngineChunk[]): AsyncIterable<EngineChunk> {
	return (async function* () {
		for (const value of chunks) yield value;
	})();
}

/** A monotonic id minter for deterministic message ids. */
function idMinter() {
	let n = 0;
	return () => `m${++n}`;
}

/** Drive pending turns to completion. */
async function settle(handle: { snapshot(): { isGenerating: boolean } }) {
	for (let i = 0; i < 200 && handle.snapshot().isGenerating; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('createConversation', () => {
	test('persists a finished text turn as user + assistant messages', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				{ type: 'text-delta', delta: 'Hello' },
				{ type: 'text-delta', delta: ' world' },
			]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('hi');
		await settle(handle);

		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(agentMessageText(messages[0]!)).toBe('hi');
		expect(agentMessageText(messages[1]!)).toBe('Hello world');
		expect(handle.snapshot().isGenerating).toBe(false);
		// The finished messages are durable: a fresh read of the store sees them.
		expect([...store.entries()]).toHaveLength(2);
	});

	test('send reports whether it started a turn', async () => {
		// The contract a caller gates side-effects on: a title write fires only when
		// send actually started a turn, so the loop owns the empty/mid-turn guard
		// and no view re-derives it.
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'ok' }]);
		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});

		expect(handle.send('')).toBe(false); // empty
		expect(handle.send('   ')).toBe(false); // whitespace only
		expect(handle.send('hi')).toBe(true); // accepted, turn now in flight
		expect(handle.send('again')).toBe(false); // mid-turn
		await settle(handle);
	});

	test('streaming holds the in-flight message during a turn, null once settled', async () => {
		// The render boundary: while a step fills a message it lives in `streaming`
		// (rendered cheaply, raw) and stays out of settled `messages`; it moves into
		// `messages` (rendered rich) once the turn persists.
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'hi' }]);
		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});

		expect(handle.snapshot().streaming).toBeNull(); // between turns

		const streamedIds = new Set<string>();
		const inMessagesWhileLive = new Set<string>();
		const unsubscribe = handle.subscribe(() => {
			const snap = handle.snapshot();
			if (!snap.isGenerating) return; // only inspect mid-turn snapshots
			if (snap.streaming) streamedIds.add(snap.streaming.id);
			for (const message of snap.messages) inMessagesWhileLive.add(message.id);
		});
		handle.send('hello'); // user = m1, assistant = m2
		await settle(handle);
		unsubscribe();

		// While streaming, the in-flight assistant is the `streaming` message, never
		// the user's turn, and it was never also in settled `messages` mid-turn.
		expect([...streamedIds]).toEqual(['m2']);
		expect(inMessagesWhileLive.has('m2')).toBe(false); // stays out of settled list
		expect(inMessagesWhileLive.has('m1')).toBe(true); // the user turn is settled
		// Once the turn settles, nothing is streaming and the message persisted.
		expect(handle.snapshot().streaming).toBeNull();
		expect(handle.snapshot().messages.map((m) => m.id)).toContain('m2');
		expect([...store.entries()].some((entry) => entry.key === 'm2')).toBe(true);
	});

	test('the streaming message gets a fresh identity per delta so reactive views update', async () => {
		// Regression: the loop mutates the in-flight message in place, so handing out
		// a stable object reference across deltas makes a memoizing reactive consumer
		// (Svelte's keyed each + $derived) freeze on the first token until reload.
		// Each snapshot must materialize the streaming message as a new object whose
		// text reflects the tokens so far.
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				{ type: 'text-delta', delta: 'Hey' },
				{ type: 'text-delta', delta: ' there' },
				{ type: 'text-delta', delta: ' friend' },
			]);
		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});

		const refs = new Set<AgentMessage>();
		const texts: string[] = [];
		const unsubscribe = handle.subscribe(() => {
			const { streaming } = handle.snapshot();
			if (streaming) {
				refs.add(streaming);
				texts.push(agentMessageText(streaming));
			}
		});
		handle.send('hi');
		await settle(handle);
		unsubscribe();

		// The text grows (the loop works) and the streaming message is a distinct
		// object each delta (so a view keyed on it re-derives instead of freezing).
		expect(texts).toContain('Hey');
		expect(texts).toContain('Hey there friend');
		expect(refs.size).toBeGreaterThan(1);
	});

	test('never prompts with the empty in-flight assistant message', async () => {
		// Regression: the loop pushes the in-flight assistant onto `turn` before a
		// step, so a naive prompt of `[...persisted, ...turn]` ends with an empty
		// assistant. A trailing empty assistant makes ChatML backends (local
		// Ollama/Qwen) emit a literal "assistant" role token and role-play the next
		// turn. The prompt must be the transcript BEFORE the message being filled.
		const store = makeStore();
		const prompts: ModelMessage[][] = [];
		const engine: AgentEngine = (request) => {
			prompts.push(request.messages);
			return streamOf([{ type: 'text-delta', delta: 'ok' }]);
		};

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('one');
		await settle(handle);
		handle.send('two');
		await settle(handle);

		expect(prompts).toHaveLength(2);
		// No prompt ends with a trailing empty assistant (the message being filled).
		for (const prompt of prompts) {
			expect(prompt.at(-1)).toMatchObject({ role: 'user' });
		}
		// Turn two carries the full prior turn plus the new user message, no empties.
		expect(prompts[1]!.map((m) => `${m.role}:${m.content}`)).toEqual([
			'user:one',
			'assistant:ok',
			'user:two',
		]);
	});

	test("a tool step's re-prompt keeps the completed step, drops the in-flight one", async () => {
		// Guards the predicate collapse: in a tool loop, `turn` holds more than one
		// assistant, so excluding the in-flight message cannot be "drop the last
		// element". The completed first step (a tool call plus its result) is
		// persistable and must re-enter the prompt; the freshly minted second step is
		// empty and must not. `isPersistableMessage` is the one rule that does both.
		const store = makeStore();
		const prompts: ModelMessage[][] = [];
		let stepCount = 0;
		const engine: AgentEngine = (request) => {
			prompts.push(request.messages);
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					{
						type: 'tool-call',
						toolCallId: 't1',
						toolName: 'get_time',
						input: {},
					},
				]);
			}
			return streamOf([{ type: 'text-delta', delta: 'It is noon.' }]);
		};
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'get_time', kind: 'query' }],
			resolve: async () => ({ content: 'noon', isError: false }),
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			generateId: idMinter(),
		});
		handle.send('what time is it');
		await settle(handle);

		expect(prompts).toHaveLength(2);
		// Step one prompts with only the user turn (the empty in-flight assistant is
		// excluded, so the prompt is not [user, assistant:""]).
		expect(prompts[0]!.map((m) => m.role)).toEqual(['user']);
		// Step two re-reads the completed tool step (assistant call + tool result) and
		// ends on the tool message, never a trailing empty assistant.
		expect(prompts[1]!.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'tool',
		]);
		expect(prompts[1]!.at(-1)).toMatchObject({
			role: 'tool',
			toolCallId: 't1',
			content: 'noon',
		});
	});

	test('runs a query tool inline and re-prompts with its result', async () => {
		const store = makeStore();
		let stepCount = 0;
		const engine: AgentEngine = () => {
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					{
						type: 'tool-call',
						toolCallId: 't1',
						toolName: 'get_time',
						input: {},
					},
				]);
			}
			return streamOf([{ type: 'text-delta', delta: 'It is noon.' }]);
		};
		const resolved: AgentToolCall[] = [];
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'get_time', kind: 'query' }],
			resolve: async (call) => {
				resolved.push(call);
				return { content: 'noon', isError: false };
			},
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			generateId: idMinter(),
		});
		handle.send('what time is it');
		await settle(handle);

		expect(resolved.map((c) => c.toolName)).toEqual(['get_time']);
		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'assistant',
		]);

		const toolStep = messages[1]!;
		expect(toolStep.parts.find((p) => p.type === 'tool-call')).toMatchObject({
			toolName: 'get_time',
		});
		expect(toolStep.parts.find((p) => p.type === 'tool-result')).toMatchObject({
			content: 'noon',
			isError: false,
		});
		expect(agentMessageText(messages[2]!)).toBe('It is noon.');
	});

	test('a runaway tool loop is bounded by the max-step guard', async () => {
		const store = makeStore();
		let calls = 0;
		// An engine that never finishes: every step asks for the same tool again.
		const engine: AgentEngine = () => {
			calls += 1;
			return streamOf([
				{
					type: 'tool-call',
					toolCallId: `t${calls}`,
					toolName: 'loop',
					input: {},
				},
			]);
		};
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'loop', kind: 'query' }],
			resolve: async () => ({ content: 'again', isError: false }),
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			generateId: idMinter(),
		});
		handle.send('go');
		await settle(handle);

		expect(handle.snapshot().isGenerating).toBe(false);
		expect(handle.snapshot().error?.code).toBe('MaxStepsExceeded');
		// The loop stopped at the cap (one engine call per step) rather than
		// spinning forever, and the unfinished turn persisted nothing.
		expect(calls).toBe(50);
		expect([...store.entries()].map((e) => e.val.role)).toEqual(['user']);
	});

	test('an asked mutation that is declined records a denial, never resolves', async () => {
		const store = makeStore();
		let stepCount = 0;
		const engine: AgentEngine = () => {
			stepCount += 1;
			if (stepCount === 1) {
				return streamOf([
					{
						type: 'tool-call',
						toolCallId: 'd1',
						toolName: 'delete_all',
						input: {},
					},
				]);
			}
			return streamOf([{ type: 'text-delta', delta: 'Okay, I will not.' }]);
		};
		let resolveCalled = false;
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'delete_all', kind: 'mutation' }],
			resolve: async () => {
				resolveCalled = true;
				return { content: 'deleted', isError: false };
			},
		};
		const approval: Approval = {
			decide: defaultApprovalDecision,
			request: async () => false,
		};

		const handle = createConversation({
			store,
			engine,
			tools,
			approval,
			generateId: idMinter(),
		});
		handle.send('delete everything');
		await settle(handle);

		expect(resolveCalled).toBe(false);
		const toolStep = handle.snapshot().messages[1]!;
		expect(toolStep.parts.find((p) => p.type === 'tool-result')).toMatchObject({
			isError: true,
		});
	});

	test('an aborted turn drops its assistant message, keeping only the user turn', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'partial' }]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});
		handle.send('hi');
		handle.stop();
		await settle(handle);

		const messages = handle.snapshot().messages;
		expect(messages.map((m) => m.role)).toEqual(['user']);
		expect(handle.snapshot().isGenerating).toBe(false);
	});

	// Guards the snapshot/persistence coupling: the live render filter and the
	// persistence filter must use one predicate, or a message could render
	// mid-turn and then vanish on a clean finish. See `snapshot` in loop.ts.
	test('every assistant message that renders live also persists', async () => {
		const store = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'streamed' }]);

		const handle = createConversation({
			store,
			engine,
			generateId: idMinter(),
		});

		// Record every assistant id that ever renders live: in settled `messages`
		// or as the `streaming` message. Both feed the same persist predicate.
		const renderedLive = new Set<string>();
		const unsubscribe = handle.subscribe(() => {
			const snap = handle.snapshot();
			if (!snap.isGenerating) return;
			if (snap.streaming?.role === 'assistant')
				renderedLive.add(snap.streaming.id);
			for (const message of snap.messages) {
				if (message.role === 'assistant') renderedLive.add(message.id);
			}
		});

		handle.send('hi');
		await settle(handle);
		unsubscribe();

		const persisted = new Set(
			[...store.entries()]
				.map((entry) => entry.val)
				.filter((message) => message.role === 'assistant')
				.map((message) => message.id),
		);
		expect([...renderedLive].sort()).toEqual([...persisted].sort());
		expect(persisted.size).toBe(1);
	});

	// The discriminator the shared predicate closes: a message can hold parts yet
	// not be persistable (an empty text part). `parts.length > 0` would render it
	// live; `isPersistableMessage` (used by both filters) drops it consistently.
	test('a parts-bearing but empty message is not persistable', () => {
		const message: AgentMessage = {
			id: 'm1',
			role: 'assistant',
			createdAt: 0,
			parts: [{ type: 'text', text: '' }],
		};
		expect(message.parts.length).toBeGreaterThan(0);
		expect(isPersistableMessage(message)).toBe(false);
	});
});
