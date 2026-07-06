/**
 * Agent Tool Approval Tests
 *
 * Verifies the shared approval gate that sits between tool callers and the
 * catalog resolver. Chat turns and direct invocations use this helper so query,
 * mutation, deny, and user-decline behavior cannot drift by caller.
 *
 * Key behaviors:
 * - Denied calls return an error without resolving the tool
 * - Declined ask-level calls return an error without resolving the tool
 * - Approved calls resolve through the catalog
 */

import { describe, expect, test } from 'bun:test';
import {
	type AgentToolCall,
	type Approval,
	resolveApprovedToolCall,
	type ToolCatalog,
} from './tools.js';

const CALL: AgentToolCall = {
	toolCallId: 't1',
	toolName: 'write_note',
	input: {},
};

function catalog({
	kind = 'mutation',
}: {
	kind?: 'query' | 'mutation';
} = {}): ToolCatalog & { resolved: AgentToolCall[] } {
	const resolved: AgentToolCall[] = [];
	return {
		resolved,
		definitions: () => [{ name: CALL.toolName, kind }],
		resolve: async (call) => {
			resolved.push(call);
			return { content: 'ran', isError: false };
		},
	};
}

function approval(decision: ReturnType<Approval['decide']>, approved = true) {
	return {
		decide: () => decision,
		request: async () => approved,
	} satisfies Approval;
}

describe('resolveApprovedToolCall', () => {
	test('denies by policy without resolving the tool', async () => {
		const tools = catalog();

		const outcome = await resolveApprovedToolCall({
			tools,
			approval: approval('deny'),
			call: CALL,
			signal: new AbortController().signal,
		});

		expect(outcome).toEqual({ content: 'Denied by policy.', isError: true });
		expect(tools.resolved).toEqual([]);
	});

	test('returns a user denial when an asked call is declined', async () => {
		const tools = catalog();

		const outcome = await resolveApprovedToolCall({
			tools,
			approval: approval('ask', false),
			call: CALL,
			signal: new AbortController().signal,
		});

		expect(outcome).toEqual({ content: 'Denied by the user.', isError: true });
		expect(tools.resolved).toEqual([]);
	});

	test('a stop during a pending approval wins over a late approval', async () => {
		const tools = catalog();
		const controller = new AbortController();
		const approval: Approval = {
			decide: () => 'ask',
			request: async () => {
				controller.abort();
				return true;
			},
		};

		const outcome = await resolveApprovedToolCall({
			tools,
			approval,
			call: CALL,
			signal: controller.signal,
		});

		expect(outcome.isError).toBe(true);
		expect(tools.resolved).toEqual([]);
	});

	test('fails closed when the call names no cataloged tool', async () => {
		const tools = catalog();

		const outcome = await resolveApprovedToolCall({
			tools,
			approval: approval('auto'),
			call: { ...CALL, toolName: 'not_in_catalog' },
			signal: new AbortController().signal,
		});

		expect(outcome).toEqual({
			content: 'No tool named not_in_catalog is available.',
			isError: true,
		});
		expect(tools.resolved).toEqual([]);
	});

	test('resolves an approved tool call', async () => {
		const tools = catalog();

		const outcome = await resolveApprovedToolCall({
			tools,
			approval: approval('ask', true),
			call: CALL,
			signal: new AbortController().signal,
		});

		expect(outcome).toEqual({ content: 'ran', isError: false });
		expect(tools.resolved).toEqual([CALL]);
	});
});
