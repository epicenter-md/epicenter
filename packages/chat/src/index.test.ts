/**
 * What this package promises: the canonical table splices into an application's
 * own workspace, and a conversation's messages survive a restart of that
 * application's store.
 *
 * The workspace here is a stand-in for a real application's (Vocab's is the live
 * one), which is the whole point: this package publishes a table shape, not a
 * workspace id.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@epicenter/agent';
import { open } from '@epicenter/data/bun';
import { defineData } from '@epicenter/data/definition';
import { InstantString } from '@epicenter/field';
import { conversationsTable, createAgentMessageStore } from './index.js';

const testDefinition = defineData({
	id: 'so.epicenter.chat-test',
	kv: {},
	tables: { conversations: { fields: conversationsTable } },
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
			const opened = await open(testDefinition, { root });
			if (opened.error !== null) throw opened.error;
			const db = opened.data;
			await using _db = db;
			const now = InstantString.fromDate(new Date('2026-07-19T00:00:00.000Z'));
			const created = db.tables.conversations.create({
				title: 'New Chat',
				model: 'test',
				createdAt: now,
				updatedAt: now,
			});
			rowId = created.id;

			const conversation = await db.tables.conversations.openDocument(rowId);
			if (conversation.error !== null) throw conversation.error;
			using document = conversation.data;
			if (document === undefined) throw new Error('the row has no document');
			using store = createAgentMessageStore(document);
			let observations = 0;
			const unobserve = store.observe(() => observations++);
			store.set(message.id, message);
			unobserve();
			expect(observations).toBe(1);
		}

		const reopened = await open(testDefinition, { root });
		if (reopened.error !== null) throw reopened.error;
		const db = reopened.data;
		await using _db = db;
		const opened = await db.tables.conversations.openDocument(rowId);
		if (opened.error !== null) throw opened.error;
		using document = opened.data;
		if (document === undefined) throw new Error('the row has no document');
		using store = createAgentMessageStore(document);
		expect([...store.entries()]).toEqual([{ key: message.id, val: message }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
