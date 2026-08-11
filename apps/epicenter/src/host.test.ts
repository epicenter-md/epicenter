/**
 * Home Host Tests
 *
 * Verifies that the host composes boxed stdio MCP tools into one conversation
 * surface and gates every mutation through the one session approval policy.
 *
 * There is nothing durable to test here any more. The host owns no application
 * data (ADR-0226), so the in-process app catalogs, the markdown folder verbs,
 * and the conversation rows that used to survive a restart are all gone, and
 * with them the tests that pinned them. What is left is what the host still
 * decides: which tools exist, who may run them, and how a direct invocation
 * settles.
 *
 * Key behaviors:
 * - MCP tools join the composed surface, and a subprocess that never speaks
 *   MCP fails host creation fast
 * - A mutation raises a host-owned approval prompt, from chat and from a
 *   direct invocation alike, and never bypasses it
 * - A pending approval dies with the process
 * - Direct invocations settle as session records without entering the
 *   transcript
 */
import { describe, expect, test } from 'bun:test';
import type {
	AgentEngine,
	AgentMessagePart,
	EngineChunk,
} from '@epicenter/agent';
import {
	createHomeHost,
	type HomeHostInputs,
	parseHomeCommand,
} from './host.ts';

const FIXTURE = new URL('../test-fixtures/mini-mcp-server.ts', import.meta.url)
	.pathname;

/**
 * A scripted engine: each model call consumes the next chunk list. The last
 * script repeats, so a trailing text answer also serves any extra step.
 */
function scriptedEngine(scripts: EngineChunk[][]): AgentEngine {
	let step = 0;
	return async function* () {
		const script = scripts[Math.min(step, scripts.length - 1)] ?? [];
		step += 1;
		for (const chunk of script) yield chunk;
	};
}

const TEST_MODEL = 'test-model';

/**
 * A host over the MCP fixture, which is the only catalog left: the in-process
 * app catalogs went with the data plane they read.
 */
function createTestHost(
	options: Pick<
		HomeHostInputs,
		'approval' | 'engine' | 'localBooks' | 'localSource'
	>,
) {
	return createHomeHost({
		model: TEST_MODEL,
		localBooks: { command: 'bun', args: [FIXTURE] },
		...options,
	});
}

async function settle(host: {
	snapshot(): { conversation: { isGenerating: boolean } };
}) {
	for (let i = 0; i < 500 && host.snapshot().conversation.isGenerating; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function waitFor(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function toolResults(parts: AgentMessagePart[]) {
	return parts.filter((part) => part.type === 'tool-result');
}

describe('createHomeHost', () => {
	test('host-owned approval prompt gates a mutation and approval resumes the turn', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'localbooks__write_off',
					input: { name: 'Needs approval' },
				},
			],
			[{ type: 'text-delta', delta: 'Created after approval.' }],
		]);
		await using host = await createTestHost({ engine });

		expect(
			await host.handleCommand({ type: 'send', content: 'create a folder' }),
		).toBe(true);
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);

		const [approval] = host.snapshot().pendingApprovals;
		expect(approval).toEqual(
			expect.objectContaining({
				toolCallId: 'call-1',
				toolName: 'localbooks__write_off',
				input: { name: 'Needs approval' },
			}),
		);

		expect(
			await host.handleCommand({
				type: 'approve',
				requestId: approval!.id,
				approved: true,
			}),
		).toBe(true);
		await settle(host);

		const { messages, error } = host.snapshot().conversation;
		expect(error).toBeNull();
		expect(host.snapshot().pendingApprovals).toEqual([]);
		const results = messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		expect(messages.at(-1)!.parts).toContainEqual({
			type: 'text',
			text: 'Created after approval.',
		});
	});

	test('always allow approves the next matching mutation without a second prompt', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'localbooks__write_off',
					input: { name: 'First' },
				},
			],
			[{ type: 'text-delta', delta: 'Created first.' }],
			[
				{
					type: 'tool-call',
					toolCallId: 'call-2',
					toolName: 'localbooks__write_off',
					input: { name: 'Second' },
				},
			],
			[{ type: 'text-delta', delta: 'Created second.' }],
		]);
		await using host = await createTestHost({ engine });

		await host.handleCommand({ type: 'send', content: 'add first' });
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'the first approval',
		);
		const [approval] = host.snapshot().pendingApprovals;
		await host.handleCommand({
			type: 'approve',
			requestId: approval!.id,
			approved: true,
			alwaysAllowSession: true,
		});
		await settle(host);

		await host.handleCommand({ type: 'send', content: 'add second' });
		await settle(host);

		expect(host.snapshot().pendingApprovals).toEqual([]);
		const results = host
			.snapshot()
			.conversation.messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(2);
		expect(results.every((result) => result.isError === false)).toBe(true);
	});

	test('a subprocess that never speaks MCP fails host creation fast', async () => {
		// Without the catalog's own connect timeout this would ride the SDK's
		// minute-long per-request default and the host would look wedged.
		await expect(
			createTestHost({
				engine: scriptedEngine([[]]),
				localBooks: {
					command: 'bun',
					args: ['-e', 'await new Promise(() => {})'],
					connectTimeoutMs: 300,
				},
			}),
		).rejects.toThrow(/timeout \(300ms\)/);
	});

	test('a stdio MCP subprocess joins the same composed surface', async () => {
		const engine = scriptedEngine([
			[
				{
					type: 'tool-call',
					toolCallId: 'call-1',
					toolName: 'localbooks__customers',
					input: {},
				},
			],
			[{ type: 'text-delta', delta: 'Acme owes the most.' }],
		]);
		await using host = await createTestHost({
			engine,
			localBooks: { command: 'bun', args: [FIXTURE] },
		});

		// The read-only hint projects to a `query`, so no approval is needed.
		const customers = host
			.toolDefinitions()
			.find((d) => d.name === 'localbooks__customers');
		expect(customers?.kind).toBe('query');

		await host.handleCommand({ type: 'send', content: 'who owes me money?' });
		await settle(host);

		const { messages, error } = host.snapshot().conversation;
		expect(error).toBeNull();
		const results = messages.flatMap((m) => toolResults(m.parts));
		expect(results).toHaveLength(1);
		expect(results[0]!.isError).toBe(false);
		expect(results[0]!.content).toContain('Acme | 4200.00');
	});

	test('a pending approval dies with the host that raised it', async () => {
		{
			await using host = await createTestHost({
				engine: scriptedEngine([
					[
						{
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'localbooks__write_off',
							input: { name: 'Never approved' },
						},
					],
				]),
			});
			await host.handleCommand({ type: 'send', content: 'write one off' });
			await waitFor(
				() => host.snapshot().pendingApprovals.length === 1,
				'a pending approval',
			);
		}

		// A second host is a second session: an unanswered prompt is host-local
		// and non-durable by design, and now so is the transcript beside it.
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		expect(host.snapshot().pendingApprovals).toEqual([]);
		expect(host.snapshot().conversation.messages).toHaveLength(0);
	});

	test('invoking a query settles succeeded without an approval or a transcript entry', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		expect(
			await host.handleCommand({
				type: 'invoke',
				toolName: 'localbooks__customers',
				input: {},
			}),
		).toBe(true);
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'succeeded',
			'the invocation to settle',
		);

		const [invocation] = host.snapshot().invocations;
		expect(invocation).toEqual(
			expect.objectContaining({
				toolName: 'localbooks__customers',
				status: 'succeeded',
			}),
		);
		expect(typeof invocation!.content).toBe('string');
		expect(invocation!.settledAt).toBeDefined();
		// A query runs unattended, and a direct run never becomes chat history.
		expect(host.snapshot().pendingApprovals).toEqual([]);
		expect(host.snapshot().conversation.messages).toEqual([]);
	});

	test('invoking an unknown tool settles failed through the shared gate', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'nope__missing',
			input: {},
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'failed',
			'the invocation to settle failed',
		);
		expect(host.snapshot().invocations[0]!.content).toMatch(
			/No tool named nope__missing/,
		);
	});

	test('invoking a mutation raises the same pending approval prompt as chat', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'localbooks__write_off',
			input: { name: 'Direct with consent' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);

		const [invocation] = host.snapshot().invocations;
		expect(invocation!.status).toBe('running');
		// The prompt correlates back to the invocation: the host mints one id
		// covering the record and the gated call.
		expect(host.snapshot().pendingApprovals[0]).toEqual(
			expect.objectContaining({
				toolCallId: invocation!.id,
				toolName: 'localbooks__write_off',
				input: { name: 'Direct with consent' },
			}),
		);
	});

	test('denying a direct mutation settles the invocation failed', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'localbooks__write_off',
			input: { name: 'Denied' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);
		await host.handleCommand({
			type: 'approve',
			requestId: host.snapshot().pendingApprovals[0]!.id,
			approved: false,
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'failed',
			'the denied invocation to settle',
		);
		expect(host.snapshot().invocations[0]!.content).toMatch(/Denied/);
		expect(host.snapshot().pendingApprovals).toEqual([]);
	});

	test('approving a direct mutation runs the tool and settles succeeded', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'localbooks__write_off',
			input: { name: 'Approved directly' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);
		await host.handleCommand({
			type: 'approve',
			requestId: host.snapshot().pendingApprovals[0]!.id,
			approved: true,
		});
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'succeeded',
			'the approved invocation to settle',
		);

		// The tool's own answer names the input it was given, so the approved
		// mutation really ran rather than merely settling.
		expect(host.snapshot().invocations[0]!.content).toContain(
			'Wrote off Approved directly',
		);
		// Direct invocation results stay session records; the transcript is untouched.
		expect(host.snapshot().conversation.messages).toEqual([]);
	});

	test('dispose settles an in-flight gated invocation failed instead of leaving it running', async () => {
		const host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		await host.handleCommand({
			type: 'invoke',
			toolName: 'localbooks__write_off',
			input: { name: 'Never answered' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'a pending approval',
		);
		await host[Symbol.asyncDispose]();

		// Disposal aborts the invoke signal before cancelAll denies the prompt,
		// so the record settles failed rather than running the tool late.
		await waitFor(
			() => host.snapshot().invocations[0]?.status === 'failed',
			'the invocation to settle after dispose',
		);
		expect(host.snapshot().invocations[0]!.settledAt).toBeDefined();
	});

	test('the invocation cap evicts settled records only; a running record survives', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		// One gated mutation stays running (its approval is never answered)...
		await host.handleCommand({
			type: 'invoke',
			toolName: 'localbooks__write_off',
			input: { name: 'Still pending' },
		});
		await waitFor(
			() => host.snapshot().pendingApprovals.length === 1,
			'the gated invocation to go pending',
		);
		const running = host.snapshot().invocations[0]!;

		// ...while more than INVOCATION_LIMIT queries settle around it. The cap
		// trims on push only, so a burst may briefly exceed it; the final push
		// converges the ring back to the limit.
		for (let i = 0; i < 25; i++) {
			await host.handleCommand({
				type: 'invoke',
				toolName: 'localbooks__customers',
				input: {},
			});
		}
		await waitFor(
			() =>
				host
					.snapshot()
					.invocations.filter((record) => record.status === 'running')
					.length === 1,
			'the query burst to settle',
		);
		await host.handleCommand({
			type: 'invoke',
			toolName: 'localbooks__customers',
			input: {},
		});
		await waitFor(
			() => host.snapshot().invocations.length === 20,
			'the ring to converge to the cap',
		);

		const survivors = host.snapshot().invocations;
		expect(survivors.find((record) => record.id === running.id)).toEqual(
			expect.objectContaining({ status: 'running' }),
		);
	});
});

describe('parseHomeCommand', () => {
	test('accepts an invoke frame with a tool name and an object input', () => {
		expect(
			parseHomeCommand({
				type: 'invoke',
				toolName: 'localbooks__write_off',
				input: { name: 'Buy milk' },
			}),
		).toEqual({
			type: 'invoke',
			toolName: 'localbooks__write_off',
			input: { name: 'Buy milk' },
		});
	});

	test('rejects invoke frames with a missing, empty, or non-string tool name', () => {
		expect(parseHomeCommand({ type: 'invoke', input: {} })).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName: '', input: {} }),
		).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName: 42, input: {} }),
		).toBeUndefined();
	});

	test('rejects invoke frames whose input is not a plain object', () => {
		const toolName = 'localbooks__customers';
		expect(parseHomeCommand({ type: 'invoke', toolName })).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName, input: null }),
		).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName, input: 'title' }),
		).toBeUndefined();
		expect(
			parseHomeCommand({ type: 'invoke', toolName, input: [1, 2] }),
		).toBeUndefined();
	});
});
