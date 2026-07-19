/** Canonical conversation document adapter and restart durability tests. */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { createDeviceBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import {
	conversationsTable,
	createAgentMessageDocumentStore,
} from './index.js';

const workspace = defineWorkspace({
	id: 'epicenter-chat-test',
	tables: { conversations: conversationsTable },
});

const message: AgentMessage = {
	id: 'message-1',
	role: 'user',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Durable hello' }],
};

test('the agent store observes writes and survives a runtime restart', async () => {
	const workspacesRoot = mkdtempSync(join(tmpdir(), 'epicenter-chat-'));
	let rowId: string;
	try {
		{
			await using runtime = createDeviceBunWorkspaceRuntime({ workspacesRoot });
			const handle = await runtime.open(workspace);
			const now = InstantString.fromDate(new Date('2026-07-19T00:00:00.000Z'));
			const row = await handle.tables.conversations.create({
				title: 'New Chat',
				model: 'test',
				createdAt: now,
				updatedAt: now,
			});
			rowId = row.id;
			using store = createAgentMessageDocumentStore(
				await handle.tables.conversations.document.open(row.id),
			);
			let observations = 0;
			const unobserve = store.observe(() => observations++);
			store.set(message.id, message);
			await store.whenDurable();
			unobserve();
			expect(observations).toBe(1);
		}

		await using reopened = createDeviceBunWorkspaceRuntime({ workspacesRoot });
		const handle = await reopened.open(workspace);
		using store = createAgentMessageDocumentStore(
			await handle.tables.conversations.document.open(rowId),
		);
		expect([...store.entries()]).toEqual([{ key: message.id, val: message }]);
	} finally {
		rmSync(workspacesRoot, { recursive: true, force: true });
	}
});
