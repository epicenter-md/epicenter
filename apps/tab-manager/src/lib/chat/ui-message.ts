/**
 * UIMessage boundary: serialization and compile-time drift detection.
 *
 * Pure functions and type assertions: no Svelte runes.
 *
 * @see https://tanstack.com/ai/latest: UIMessage / MessagePart types
 */

import type { MessagePart } from '@tanstack/ai';
import type { UIMessage } from '@tanstack/ai-svelte';
import type { ChatMessage } from '$lib/workspace';

// ── Type test utilities ───────────────────────────────────────────────
// Rolling-your-own type testing from Total TypeScript.
// @see https://www.totaltypescript.com/how-to-test-your-types#rolling-your-own

type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// ── Derive the actual MessagePart type from UIMessage ─────────────────
// This is the type that gets stored in Y.Doc via onFinish/sendMessage.

// ── Compile-time drift detection ──────────────────────────────────────
// If TanStack AI adds, removes, or renames a part type, TypeScript
// reports a type error here, forcing us to update our understanding.

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking';

type _DriftCheck = Expect<Equal<MessagePart['type'], ExpectedPartTypes>>;

// ── Typed boundary: unknown[] → MessagePart[] ─────────────────────────

/**
 * Convert a persisted chat message to a TanStack AI UIMessage.
 *
 * This is the single boundary where `unknown[]` is cast to `MessagePart[]`.
 * Safe because parts are always produced by TanStack AI and round-tripped
 * through Y.Doc serialization (structuredClone-compatible, lossless for
 * plain objects).
 */
export function toUiMessage(message: ChatMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as unknown as MessagePart[],
		createdAt: new Date(message.createdAt),
	};
}

export type { MessagePart };
