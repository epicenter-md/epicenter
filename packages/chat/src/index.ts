import { field } from '@epicenter/data/definition';
import * as Y from '@y/y';
/**
 * The canonical conversation shape every chat surface shares: the fields a
 * `conversations` table declares, the id vocabulary, its file codec, and the
 * adapter that presents one conversation's message field as the agent loop's
 * store.
 *
 * Inert, and deliberately so. Nothing here opens a document, mints an address,
 * or knows which document a conversation lives in. An application splices
 * {@link conversationsTable} into its own workspace under its own id,
 * opens its own document (device or account, ADR-0233), and hands the row's
 * `messages` field to {@link createAgentMessageStore}. Vocab has always worked this
 * way and said so; the `chatLens` that used to sit beside the table was a
 * declaration no application ever bound, kept alive by its own test, and a
 * standalone declaration is a standalone document, which is exactly what a
 * sub-feature of an application must not be.
 */

import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
/**
 * Two packages, because two different things are being named.
 *
 * `TypedTableHandle` is a runtime handle a store constructs, so it comes from
 * `@epicenter/data`. `RowOf` is inert contract vocabulary owned by
 * `@epicenter/data/definition`; `@epicenter/data` re-exports it, but reaching it
 * through the runtime would say this module builds its schema out of a SQLite
 * projection, which it never does.
 *
 * Both stay runtime dependencies. This package publishes raw TypeScript
 * (`exports` is `./src/index.ts`, with no build and no declaration emit), so a
 * consumer compiles these very lines, and a type-only import it cannot resolve
 * is as fatal as a value one.
 */
import type { TypedTableHandle } from '@epicenter/data';
import {
	RowFileError,
	type RowOf,
	type ScalarsOf,
} from '@epicenter/data/definition';
import type { Brand } from 'wellcrafted/brand';
import { Ok, type Result } from 'wellcrafted/result';

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
	/**
	 * The conversation's finished messages: a nested `Y.Type` on the row
	 * (ADR-0295, ADR-0296).
	 *
	 * Minted with the row and never again, which is what removes the race a
	 * name-addressed root used to close: a nested type is addressed by the
	 * struct that created it, so two devices minting one would lose a subtree,
	 * and only the creating device ever mints this.
	 */
	messages: field.type(),
} as const;

/**
 * The conversations table's file codec (ADR-0296).
 *
 * A table that declares a rich field must declare one, because the export is
 * the only bridge the messages have out of the CRDT and a folder written
 * without them feeds an import that deletes them everywhere.
 *
 * The body is the message log as JSON, one entry per line of a pretty-printed
 * array, which is what makes a diff of two exports legible. It is not
 * Markdown, and that is the point of the codec being the TABLE's: a
 * conversation is a log of structured parts, not prose, and only this package
 * knows that.
 */
export const conversationsFile = {
	serialize: ({
		id: _id,
		messages,
		...fields
	}: RowOf<typeof conversationsTable>) => ({
		data: fields,
		content: JSON.stringify(
			[...messages.attrEntries()].map(([key, val]) => ({
				key: String(key),
				val,
			})),
			null,
			2,
		),
	}),
	deserialize: (file: {
		data: Record<string, unknown>;
		content: string;
	}): Result<
		ScalarsOf<typeof conversationsTable> & { messages: Y.Type },
		RowFileError
	> => {
		// Built here and handed back (ADR-0296, amended). `create` integrates it
		// in the transaction that mints the row; nothing reads it before then,
		// because a detached type reads as empty until it is integrated.
		const messages = new Y.Type();
		if (file.content.trim() !== '') {
			let entries: unknown;
			try {
				entries = JSON.parse(file.content);
			} catch (cause) {
				return RowFileError.Unreadable({
					reason: 'the message log is not JSON',
					cause,
				});
			}
			if (!Array.isArray(entries)) {
				return RowFileError.Unreadable({
					reason: 'the message log is not an array of entries',
				});
			}
			for (const entry of entries as { key?: unknown; val?: unknown }[]) {
				if (typeof entry?.key !== 'string') {
					return RowFileError.Unreadable({
						reason: 'a message entry carries no id',
					});
				}
				messages.setAttr(entry.key, entry.val);
			}
		}
		// Verbatim, so a key an older release wrote survives the round trip; a
		// row this declaration cannot read is reported on the first read rather
		// than repaired here (ADR-0125).
		return Ok({
			...(file.data as ScalarsOf<typeof conversationsTable>),
			messages,
		});
	},
};

/** One conversation row, as a read hands it back. */
export type Conversation = RowOf<typeof conversationsTable>;

/** The bound `conversations` table handle, whichever document holds it. */
export type ConversationsTable = TypedTableHandle<typeof conversationsTable>;

/**
 * Present one conversation's `messages` field as the agent loop's by-id store.
 *
 * An adapter and nothing more: it opens nothing and releases nothing. The type
 * is live on the database's one document (ADR-0295), so its lifetime is the
 * row's; durability is the store's write-behind and propagation is the
 * ordinary transport.
 *
 * @param messages The row's `messages` field, from `table.get(id)?.messages`.
 */
export function createAgentMessageStore(messages: Y.Type): AgentMessageStore {
	return {
		set(key, value) {
			messages.setAttr(key, value);
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
