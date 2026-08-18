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
 * `RowDocument` and `TypedTableHandle` are runtime handles a store constructs,
 * so they come from `@epicenter/data`. `RowOf` is inert contract vocabulary
 * owned by `@epicenter/database`; `@epicenter/data` re-exports it, but reaching it
 * through the runtime would say this module builds its schema out of a SQLite
 * projection, which it never does.
 *
 * Both stay runtime dependencies. This package publishes raw TypeScript
 * (`exports` is `./src/index.ts`, with no build and no declaration emit), so a
 * consumer compiles these very lines, and a type-only import it cannot resolve
 * is as fatal as a value one.
 */
import type { RowDocument, TypedTableHandle } from '@epicenter/data';
import type { RowOf } from '@epicenter/database';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = string & Brand<'ConversationId'>;

export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * The fields a conversation row carries, as the arktype expressions a
 * workspace is written in (ADR-0213).
 *
 * Spliced into an application's own workspace rather than published as one,
 * because a table root is addressed by its NAME inside whichever document holds
 * it: two workspaces opened over one store share `conversations` whatever
 * namespaces they declare. So the shape is the reusable thing, and the
 * id is the application.s.
 *
 * @example
 * ```ts
 * export const vocabWorkspace = defineDatabase({
 *   id: 'so.epicenter.vocab',
 *   tables: { conversations: conversationsTable, entries: entriesTable },
 * });
 * ```
 */
export const conversationsTable = {
	title: 'string',
	model: 'string',
	// Validation-only rather than `string.date.parse`: a field has to be one
	// type through the CRDT attribute, the projection column and the row alike,
	// and a parsing form would hand back a `Date` that could not round-trip.
	createdAt: 'string.date.iso',
	updatedAt: 'string.date.iso',
} as const;

/** One conversation row, as a read hands it back. */
export type Conversation = RowOf<typeof conversationsTable>;

/** The bound `conversations` table handle, whichever document holds it. */
export type ConversationsTable = TypedTableHandle<typeof conversationsTable>;

/**
 * The root a conversation's finished messages live at, inside the
 * conversation's own row document.
 *
 * Named at `create` rather than felt for on first open, and that is a
 * correctness requirement rather than tidiness. `document(id).get(name)`
 * creates on miss, and a created nested type is addressed by the operation that
 * made it, so two devices first-opening one conversation would each mint a root
 * here and map LWW would discard one along with every message in it (ADR-0215).
 *
 * @example
 * ```ts
 * table.create(fields, { document: [CONVERSATION_MESSAGES] });
 * ```
 */
export const CONVERSATION_MESSAGES = 'messages';

/**
 * Present one conversation's message root as the agent loop's by-id store.
 *
 * An adapter and nothing more: it owns no document, opens nothing, and releases
 * nothing. The messages live at a root inside the row's own container, in the
 * application's one document, so their durability is the store's write-behind
 * and their propagation is the ordinary transport. There is no lease to hold,
 * which is why the earlier shape's `whenDurable` and async disposal are gone
 * rather than forwarded: they described a per-conversation document that had to
 * be opened and closed, and no such thing exists now.
 *
 * @param document The row document, from `table.document(conversationId)`.
 */
export function createAgentMessageStore(
	document: RowDocument,
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
