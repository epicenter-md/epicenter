/**
 * A process-local, in-memory {@link AgentMessageStore} for the Slice 1 host.
 *
 * The shipped chat persists its transcript to a Yjs `conversations.messages`
 * records store (opensidian) that survives reload and syncs. Slice 1 is a
 * headless, ephemeral demonstration of cross-app verb composition, so the
 * transcript lives only in this process. Swapping this for the real records
 * handle is the durability work of a later slice, not a Slice 1 concern; the
 * loop consumes the same `set / entries / observe` surface either way.
 */

import type { AgentMessage } from '@epicenter/workspace/agent';

/** What `createConversation` needs of a store: `set / entries / observe` + dispose. */
export type InMemoryMessageStore = {
	set(key: string, value: AgentMessage): void;
	entries(): IterableIterator<{ key: string; val: AgentMessage }>;
	observe(handler: () => void): () => void;
	[Symbol.dispose](): void;
};

export function createInMemoryMessageStore(): InMemoryMessageStore {
	const map = new Map<string, AgentMessage>();
	const handlers = new Set<() => void>();
	return {
		set(key, value) {
			map.set(key, value);
			for (const handler of handlers) handler();
		},
		*entries() {
			for (const [key, val] of map) yield { key, val };
		},
		observe(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		[Symbol.dispose]() {
			handlers.clear();
			map.clear();
		},
	};
}
