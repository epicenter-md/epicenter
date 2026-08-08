/**
 * Canonical conversation domain and Data definition.
 *
 * Each product binds this definition through its Data runtime.
 * Finished messages live in the row-owned Yjs 14 document under one `messages`
 * map; live turns remain client state.
 */

import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
/**
 * Two packages, because two different things are being named.
 *
 * `TableLens` and `RowDocument` are runtime handles a Data engine constructs, so
 * they come from `@epicenter/data`. Everything this module *declares* is inert
 * contract vocabulary owned by `@epicenter/lens`; `@epicenter/data` re-exports
 * it, but reaching it through the runtime would say this module builds its
 * schema out of a SQLite replica, which it never does.
 *
 * Both stay runtime dependencies. This package publishes raw TypeScript
 * (`exports` is `./src/index.ts`, with no build and no declaration emit), so a
 * consumer compiles these very lines, and a type-only import it cannot resolve
 * is as fatal as a value one.
 */
import type { RowDocument, TableLens } from '@epicenter/data/legacy';
import { field } from '@epicenter/field';
import { defineLens, defineTable, type RowFor } from '@epicenter/lens/legacy';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = string & Brand<'ConversationId'>;

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

export const chatLens = defineLens({
	namespace: 'so.epicenter.chat',
	tables: { conversations: conversationsTable },
});

export type Conversation = RowFor<typeof conversationsTable>;

export type ConversationsTable = TableLens<typeof conversationsTable>;

export type AgentMessageDocumentStore = AgentMessageStore & {
	/** Wait for every message write issued before this call to reach local storage. */
	whenDurable(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Bind the agent loop's by-id store to one canonical row document. */
export function createAgentMessageDocumentStore(
	document: RowDocument,
): AgentMessageDocumentStore {
	const messages = document.get('messages');
	let disposed = false;
	let disposal: Promise<void> | undefined;
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
			disposal = document[Symbol.asyncDispose]();
		},
		async [Symbol.asyncDispose]() {
			if (!disposed) {
				disposed = true;
				disposal = document[Symbol.asyncDispose]();
			}
			await disposal;
		},
	};
}
