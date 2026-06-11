/**
 * UIMessage boundary: persisted chat message to TanStack AI UIMessage.
 *
 * Single boundary where unknown[] is cast to MessagePart[].
 * Safe because parts are always produced by TanStack AI.
 */

import type { ChatMessage } from '@epicenter/zhongwen';
import type { MessagePart } from '@tanstack/ai';
import type { UIMessage } from '@tanstack/ai-client';

export function toUiMessage(message: ChatMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as unknown as MessagePart[],
		createdAt: new Date(message.createdAt),
	};
}
