/**
 * What this package promises: the canonical table splices into an application's
 * own workspace, and a conversation's messages survive a restart of that
 * application's store.
 *
 * The workspace here is a stand-in for a real application's (Vocab's is the live
 * one), which is the whole point: this package publishes a table shape, not a
 * namespace.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@epicenter/agent';
import { open } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { defineWorkspace } from '@epicenter/workspace';
import {
	CONVERSATION_MESSAGES,
	conversationsTable,
	createAgentMessageStore,
} from './index.js';

const testWorkspace = defineWorkspace({
	namespace: 'so.epicenter.chat-test',
	tables: { conversations: conversationsTable },
});

const message: AgentMessage = {
	id: 'message-1',
	role: 'user',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Durable hello' }],
};

test('the agent store observes writes and survives a restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-chat-'));
	let rowId: string;
	try {
		{
			const opened = await open(testWorkspace, { root });
			if (opened.error !== null) throw opened.error;
			await using db = opened.data;
			const now = InstantString.fromDate(new Date('2026-07-19T00:00:00.000Z'));
			const created = db.tables.conversations.create(
				{ title: 'New Chat', model: 'test', createdAt: now, updatedAt: now },
				{ document: [CONVERSATION_MESSAGES] },
			);
			if (created.error !== null) throw created.error;
			rowId = created.data.id;

			const document = db.tables.conversations.document(rowId);
			if (document === undefined) throw new Error('the row has no document');
			using store = createAgentMessageStore(document);
			let observations = 0;
			const unobserve = store.observe(() => observations++);
			store.set(message.id, message);
			unobserve();
			expect(observations).toBe(1);
		}

		const reopened = await open(testWorkspace, { root });
		if (reopened.error !== null) throw reopened.error;
		await using db = reopened.data;
		const document = db.tables.conversations.document(rowId);
		if (document === undefined) throw new Error('the row has no document');
		using store = createAgentMessageStore(document);
		expect([...store.entries()]).toEqual([{ key: message.id, val: message }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
