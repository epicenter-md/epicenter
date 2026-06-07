/**
 * Opensidian workspace contract: id, branded types, tables, base actions, and
 * per-row child document models. Isomorphic: no IndexedDB, WebSockets, Svelte
 * state, browser shell APIs, or daemon process lifecycle.
 *
 * Distribution: `apps/opensidian/package.json` exports this file as the
 * `opensidian` package root. Browser code, daemon code, and tests all import
 * from here. The table shapes here are the wire contract for sync; forking a
 * column shape breaks sync compatibility with peers running the canonical
 * schema.
 *
 * Composition lives elsewhere:
 *  - `apps/opensidian/opensidian.browser.ts` -> `openOpensidianBrowser({ signedIn, deviceId })`
 *  - `apps/opensidian/project.ts`                    -> `opensidian()` mount factory
 */

import {
	type FileId,
	fileContentDocGuid,
	filesTable,
} from '@epicenter/filesystem';
import { field, jsonValue } from '@epicenter/field';
import {
	attachTimeline,
	createDisposableCache,
	createWorkspace,
	defineActions,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	type Keyring,
	nullable,
	onLocalUpdate,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import * as Y from 'yjs';

export const OPENSIDIAN_ID = 'epicenter-opensidian';

/**
 * Branded conversation ID for a single chat thread.
 *
 * Used as the primary key for conversations and as the foreign key for all
 * messages that belong to that thread. The brand prevents accidental mixing
 * with message IDs or other plain strings.
 */
export type ConversationId = Id & Brand<'ConversationId'>;

/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ConversationId` should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * Generate a unique {@link ConversationId} for a new conversation row.
 *
 * This keeps call sites from casting raw strings and makes the ID source of
 * truth obvious wherever a conversation is created.
 */
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

/**
 * Branded chat message ID for one persisted assistant, user, or system message.
 *
 * The brand keeps message IDs distinct from conversation IDs so references
 * stay type-safe across joins and edits.
 */
export type ChatMessageId = Id & Brand<'ChatMessageId'>;

/**
 * Syntactic sugar for `value as ChatMessageId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ChatMessageId` should appear.
 */
export const asChatMessageId = (value: string): ChatMessageId =>
	value as ChatMessageId;

/**
 * Generate a unique {@link ChatMessageId} for a new chat message.
 *
 * This mirrors {@link generateConversationId} and centralizes the branded ID
 * cast in one place.
 */
export const generateChatMessageId = (): ChatMessageId =>
	generateId<ChatMessageId>();

/**
 * Conversations: metadata for each chat thread.
 *
 * Stores the thread title, optional parent/subpage relationship, source
 * message linkage, and the model/provider metadata needed to resume or audit
 * the conversation later.
 */
const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	parentId: nullable(field.string<ConversationId>()),
	sourceMessageId: nullable(field.string<ChatMessageId>()),
	systemPrompt: nullable(field.string()),
	provider: field.string(),
	model: field.string(),
	createdAt: field.number(),
	updatedAt: field.number(),
});
export type Conversation = InferTableRow<typeof conversationsTable>;

/**
 * Chat messages: the persisted content of each conversation turn.
 *
 * Stores the role, structured content parts, and creation timestamp so the UI
 * can replay the exact chat history without depending on live model state.
 */
const chatMessagesTable = defineTable({
	id: field.string<ChatMessageId>(),
	conversationId: field.string<ConversationId>(),
	role: field.select(['user', 'assistant', 'system']),
	parts: field.json(Type.Array(jsonValue)),
	createdAt: field.number(),
});
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

/**
 * Tool trust: per-tool approval preferences for chat actions.
 *
 * Tracks whether a tool should keep asking for approval or be auto-approved,
 * which lets Opensidian remember the user's trust decisions across sessions.
 */
const toolTrustTable = defineTable({
	id: field.string(),
	trust: field.select(['ask', 'always']),
});
export type ToolTrust = InferTableRow<typeof toolTrustTable>;

/**
 * Build an Opensidian workspace bundle:
 * `{ ydoc, tables, kv, actions, fileContentDocs }`.
 *
 * Combines the filesystem-backed notes table with the chat tables so the app
 * can store notes, conversations, messages, and tool approvals in one schema.
 *
 * Encrypted under the supplied keyring. Runtime openers attach persistence,
 * sync, browser services, materializers, and UI state around this shared model.
 */
export function createOpensidian(opts: { keyring: () => Keyring }) {
	const workspace = createWorkspace({
		id: OPENSIDIAN_ID,
		keyring: opts.keyring,
		tables: {
			files: filesTable,
			conversations: conversationsTable,
			chatMessages: chatMessagesTable,
			toolTrust: toolTrustTable,
		},
		kv: {},
	});
	const fileContentDocs = createDisposableCache((fileId: FileId) => {
		const childYdoc = new Y.Doc({
			guid: opensidianFileContentDocGuid(fileId),
			gc: true,
		});

		onLocalUpdate(childYdoc, () =>
			workspace.tables.files.update(fileId, { updatedAt: Date.now() }),
		);

		return {
			ydoc: childYdoc,
			content: attachTimeline(childYdoc),
			[Symbol.dispose]() {
				childYdoc.destroy();
			},
		};
	});

	return defineWorkspace({
		...workspace,
		actions: defineActions({}),
		fileContentDocs,
		[Symbol.dispose]() {
			fileContentDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
		},
	});
}
export type OpensidianWorkspace = ReturnType<typeof createOpensidian>;

/**
 * Deterministic guid of a file's content sub-doc.
 *
 * Browser editors, daemon materializers, and wipe paths reach this same
 * function so every layer points at the same Y.Doc identity. Thin wrapper
 * around {@link fileContentDocGuid} that pins the workspace id.
 */
export function opensidianFileContentDocGuid(fileId: FileId): string {
	return fileContentDocGuid({
		workspaceId: OPENSIDIAN_ID,
		fileId,
	});
}
