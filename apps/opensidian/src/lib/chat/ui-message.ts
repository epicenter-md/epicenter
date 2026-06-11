/**
 * UIMessage boundary: persisted chat rows on one side, TanStack AI types on the other.
 *
 * Opensidian stores chat messages in the workspace CRDT as JSON-compatible data,
 * but the chat UI and model adapters speak TanStack AI's `UIMessage` / `MessagePart`
 * types at runtime. Keeping the conversion in one file makes schema drift loud: if
 * either side changes shape, TypeScript fails here instead of letting the mismatch
 * leak through the app.
 */

import type { MessagePart } from '@tanstack/ai';
import type { UIMessage } from '@tanstack/ai-svelte';

import type { ChatMessage, ChatMessageId } from 'opensidian';

type Expect<T extends true> = T;
type Equal<TLeft, TRight> =
	(<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
		? true
		: false;

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking';

type _ChatMessageIdDriftCheck = Expect<Equal<ChatMessage['id'], ChatMessageId>>;
type _PartTypeDriftCheck = Expect<
	Equal<MessagePart['type'], ExpectedPartTypes>
>;

/**
 * Convert one persisted workspace chat message into TanStack AI's runtime message.
 *
 * This is the single boundary where the JSON-backed `parts` array is retyped to
 * `MessagePart[]` for the UI layer.
 */
export function toUiMessage(msg: ChatMessage): UIMessage {
	return {
		id: msg.id,
		role: msg.role,
		parts: msg.parts as unknown as MessagePart[],
		createdAt: new Date(msg.createdAt),
	};
}

/**
 * Convert persisted chat messages into TanStack AI messages for rendering.
 *
 * Useful when the UI needs a full conversation transcript, not a single row.
 */
export function toUiMessages(msgs: ChatMessage[]): UIMessage[] {
	return msgs.map(toUiMessage);
}
