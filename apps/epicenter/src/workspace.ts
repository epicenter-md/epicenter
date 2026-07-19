/** Epicenter Home's device-owned durable conversation workspace. */

import { conversationsTable } from '@epicenter/chat';
import {
	defineWorkspace,
	type WorkspaceHandle,
} from '@epicenter/workspace/sqlite';

export const conversationsWorkspace = defineWorkspace({
	id: 'epicenter-conversations',
	tables: { conversations: conversationsTable },
});

export type ConversationsWorkspace = WorkspaceHandle<
	typeof conversationsWorkspace
>;
