/**
 * Canonical conversation domain and SQLite workspace lens.
 *
 * Each product binds this table through its own Device or Account workspace.
 * Finished messages live in the row-owned Yjs 14 document under one `messages`
 * map; live turns remain client state.
 */

import { field } from '@epicenter/field';
import type {
	AgentMessage,
	AgentMessageStore,
} from '@epicenter/workspace/agent';
import {
	defineTable,
	type RowDocument,
	type RowFor,
	type WorkspaceTables,
} from '@epicenter/workspace/sqlite';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = string & Brand<'ConversationId'>;

export const generateConversationId = (): ConversationId =>
	crypto.randomUUID() as ConversationId;

export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

export const conversationsTable = defineTable({
	fields: {
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
});

export type Conversation = RowFor<typeof conversationsTable>;

export type ConversationsTable = WorkspaceTables<{
	conversations: typeof conversationsTable;
}>['conversations'];

export type AgentMessageDocumentStore = AgentMessageStore & {
	/** Wait for every message write issued before this call to reach local storage. */
	whenDurable(): Promise<void>;
};

/** Bind the agent loop's by-id store to one canonical row document. */
export function createAgentMessageDocumentStore(
	document: RowDocument,
): AgentMessageDocumentStore {
	const messages = document.get('messages');
	let disposed = false;
	const requireOpen = () => {
		if (disposed) throw new Error('Agent message store is disposed');
	};

	return {
		set(key, value) {
			requireOpen();
			document.transact(() => messages.setAttr(key, value));
		},
		*entries() {
			requireOpen();
			for (const [key, val] of messages.attrEntries()) {
				yield { key: String(key), val: val as AgentMessage };
			}
		},
		observe(handler) {
			requireOpen();
			messages.observe(handler);
			return () => messages.unobserve(handler);
		},
		whenDurable() {
			requireOpen();
			return document.whenDurable();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			document[Symbol.dispose]();
		},
	};
}
