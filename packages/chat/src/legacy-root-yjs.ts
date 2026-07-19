/**
 * Frozen root-Yjs conversation table for apps that have not reached the
 * canonical SQLite workspace runtime. New consumers use the package root.
 */

import { field } from '@epicenter/field';
import {
	attachRecords,
	type ConnectedTables,
	defineTable,
} from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import type { ConversationId } from './index.js';

export const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	model: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
}).docs({ messages: (ydoc) => attachRecords<AgentMessage>(ydoc) });

export type ConversationsTable = ConnectedTables<{
	conversations: typeof conversationsTable;
}>['conversations'];
