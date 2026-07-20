/** Epicenter Home's device-owned durable conversation workspace. */

import { conversationsTable } from '@epicenter/chat';
import { defineWorkspace, type Workspace } from '@epicenter/workspace/sqlite';

export const conversationsWorkspace = defineWorkspace({
	id: 'epicenter-conversations',
	tables: { conversations: conversationsTable },
});

export type ConversationsWorkspace = Workspace<typeof conversationsWorkspace>;
