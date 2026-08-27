import { field } from '@epicenter/data/definition';
/**
 * The canonical conversation shape every chat surface shares: the fields a
 * `conversations` table declares, the id vocabulary, and the adapter that
 * presents one conversation's message root as the agent loop's store.
 *
 * Inert, and deliberately so. Nothing here opens a document, mints an address,
 * or knows which document a conversation lives in. An application splices
 * {@link conversationsTable} into its own workspace under its own id,
 * opens its own document (device or account, ADR-0233), and hands the row's
 * message root to {@link createAgentMessageStore}. Vocab has always worked this
 * way and said so; the `chatLens` that used to sit beside the table was a
 * declaration no application ever bound, kept alive by its own test, and a
 * standalone declaration is a standalone document, which is exactly what a
 * sub-feature of an application must not be.
 */

import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
/**
 * Two packages, because two different things are being named.
 *
 * `RowDocumentHandle` and `TypedTableHandle` are runtime handles a store
 * constructs, so they come from `@epicenter/data`. `RowOf` is inert contract vocabulary
 * owned by `@epicenter/data/definition`; `@epicenter/data` re-exports it, but reaching it
 * through the runtime would say this module builds its schema out of a SQLite
 * projection, which it never does.
 *
 * Both stay runtime dependencies. This package publishes raw TypeScript
 * (`exports` is `./src/index.ts`, with no build and no declaration emit), so a
 * consumer compiles these very lines, and a type-only import it cannot resolve
 * is as fatal as a value one.
 */
import type { RowDocumentHandle, TypedTableHandle } from '@epicenter/data';
import type { RowOf } from '@epicenter/data/definition';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = string & Brand<'ConversationId'>;

export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * The fields a conversation row carries, as closed descriptors in a data
 * definition (ADR-0213).
 *
 * Spliced into an application's own workspace rather than published as one,
 * because a table root is addressed by its NAME inside whichever document holds
 * it: two workspaces opened over one store share `conversations` whatever
 * namespaces they declare. So the shape is the reusable thing, and the
 * id is the application.s.
 *
 * @example
 * ```ts
 * export const vocabDefinition = defineData({
 *   id: 'so.epicenter.vocab',
 *   tables: {
 *     conversations: { fields: conversationsTable },
 *     entries: { fields: entriesTable },
 *   },
 * });
 * ```
 */
export const conversationsTable = {
	title: field.string(),
	model: field.string(),
	// Validation-only rather than `string.date.parse`: a field has to be one
	// type through the CRDT attribute, the projection column and the row alike,
	// and a parsing form would hand back a `Date` that could not round-trip.
	createdAt: field.instant(),
	updatedAt: field.instant(),
} as const;

/** One conversation row, as a read hands it back. */
export type Conversation = RowOf<typeof conversationsTable>;

/** The bound `conversations` table handle, whichever document holds it. */
export type ConversationsTable = TypedTableHandle<typeof conversationsTable>;

/**
 * The root a conversation's finished messages live at, inside the
 * conversation's own independent document (ADR-0248).
 *
 * One spelling, used at every open. Minting on first use is safe: a top-level
 * root is addressed by its name, so two devices first-opening one
 * conversation converge with both sides' messages retained.
 *
 * @example
 * ```ts
 * const { data: handle } = await table.openDocument(conversationId);
 * ```
 */
export const CONVERSATION_MESSAGES = 'messages';

/**
 * Present one conversation's message root as the agent loop's by-id store.
 *
 * An adapter and nothing more: it opens nothing and releases nothing. The
 * caller opened the conversation's document and keeps the handle alive for as
 * long as the loop runs; durability is the store's write-behind and
 * propagation is the ordinary transport.
 *
 * @param document The open handle, from `await table.openDocument(conversationId)`.
 */
export function createAgentMessageStore(
	document: Pick<RowDocumentHandle, 'get'>,
): AgentMessageStore {
	const messages = document.get(CONVERSATION_MESSAGES);

	return {
		set(key, value) {
			messages.setAttr(key as never, value as never);
		},
		*entries() {
			for (const [key, val] of messages.attrEntries()) {
				yield { key: String(key), val: val as AgentMessage };
			}
		},
		observe(handler) {
			messages.observe(handler);
			return () => messages.unobserve(handler);
		},
		// Nothing to release. The loop still calls it, because a store backed by
		// something with a lifetime would need it; this one is a view onto a type
		// the application's document already holds.
		[Symbol.dispose]() {},
	};
}
