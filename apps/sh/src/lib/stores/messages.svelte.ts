import type { Accessor } from '@tanstack/svelte-query';
import { type } from 'arktype';
import { createSubscriber } from 'svelte/reactivity';

import { createAssistantClient } from '$lib/client/client.gen';
import * as api from '$lib/client/sdk.gen';
import type {
	AssistantMessage,
	EventMessagePartUpdated,
	EventMessageRemoved,
	EventMessageUpdated,
	Message as MessageInfo,
	Part,
} from '$lib/client/types.gen';
import type { AssistantConfig } from '$lib/stores/assistant-configs.svelte';

export type Message = { info: MessageInfo; parts: Part[] };

/**
 * Creates a reactive message subscriber for real-time SSE updates
 *
 * @param params - Configuration object containing assistant, sessionId, and initial messages
 * @param params.assistant - Accessor to the assistant configuration
 * @param params.sessionId - Accessor to the session ID
 * @param params.initialMessages - Accessor to pre-fetched messages from the load function
 * @returns A reactive value containing the messages with their parts
 *
 * @remarks
 * This subscriber is responsible for keeping messages in sync after the initial load.
 * The initial messages must be fetched separately in the load function using the query layer.
 *
 * @example
 * ```ts
 * const messages = createMessageSubscriber({
 *   assistant: () => assistantConfig,
 *   sessionId: () => session.id,
 *   initialMessages: () => data.messages
 * });
 *
 * // Use in component
 * $effect(() => {
 *   console.log('Messages:', messages.value);
 * });
 * ```
 */
export function createMessageSubscriber({
	assistant,
	initialMessages,
	sessionId,
}: {
	assistant: Accessor<AssistantConfig>;
	initialMessages: Accessor<Message[]>;
	sessionId: Accessor<string>;
}) {
	// Initialize with pre-fetched messages
	let messages = $state<Message[]>(initialMessages());
	let eventSource: EventSource | null = null;

	/**
	 * Replaces an existing message or appends a new one to the messages array
	 *
	 * @param updatedMessage - The complete message object to update or add
	 *
	 * @remarks
	 * This is typically used when receiving a `message.updated` event which contains
	 * the full message state. If a message with the same ID exists, it will be
	 * replaced entirely while preserving its parts. Otherwise, the message is
	 * appended to the end of the array with empty parts.
	 */
	function upsertMessage(updatedMessage: MessageInfo) {
		const existingIndex = messages.findIndex(
			(msg) => msg.info.id === updatedMessage.id,
		);

		if (existingIndex >= 0) {
			// Preserve existing parts when updating message info
			messages = [
				...messages.slice(0, existingIndex),
				{
					info: updatedMessage,
					parts: messages[existingIndex].parts,
				},
				...messages.slice(existingIndex + 1),
			];
		} else {
			// Add new message with empty parts array
			messages = [
				...messages,
				{
					info: updatedMessage,
					parts: [],
				},
			];
		}
	}

	/**
	 * Merges a streaming message part into an existing message's parts array
	 *
	 * @param messageId - The ID of the message to update
	 * @param part - The message part to merge (text, tool, or step marker)
	 *
	 * @remarks
	 * This handles the streaming nature of assistant responses:
	 * - Text parts: Concatenates consecutive text chunks into a single part to avoid fragmentation
	 * - Tool parts: Updates existing tool calls by ID or appends new ones
	 * - Step markers: Always appends to maintain chronological order
	 *
	 * @example
	 * // Streaming text chunks get concatenated:
	 * // Part 1: { type: 'text', text: 'Hello' }
	 * // Part 2: { type: 'text', text: ' world' }
	 * // Result: [{ type: 'text', text: 'Hello world' }]
	 */
	function mergeStreamingPart(messageId: string, part: Part) {
		messages = messages.map((msg) => {
			if (msg.info.id !== messageId) return msg;

			// Handle different part types
			if (part.type === 'text') {
				// Check if this part already exists (streaming update)
				const existingIndex = msg.parts.findIndex(
					(p) => p.type === 'text' && p.id === part.id,
				);

				if (existingIndex >= 0) {
					// This is an update to an existing part, replace it entirely
					console.log('Updating existing text part at index', existingIndex);
					const updatedParts = [...msg.parts];
					updatedParts[existingIndex] = part;
					return { ...msg, parts: updatedParts };
				}
				// This is a new text part, add it
				console.log('Adding new text part');
				return { ...msg, parts: [...msg.parts, part] };
			}

			// For tool parts, update by ID or append
			if (part.type === 'tool') {
				const existingIndex = msg.parts.findIndex(
					(p) => p.type === 'tool' && p.id === part.id,
				);

				if (existingIndex >= 0) {
					const updatedParts = [...msg.parts];
					updatedParts[existingIndex] = part;
					return { ...msg, parts: updatedParts };
				}
				return { ...msg, parts: [...msg.parts, part] };
			}

			// For other part types (step-start, step-finish, snapshot, file), just append
			return { ...msg, parts: [...msg.parts, part] };
		});
	}

	/**
	 * Removes a message from the messages array by ID
	 *
	 * @param messageId - The ID of the message to remove
	 *
	 * @remarks
	 * Used when receiving a `message.removed` event, typically when:
	 * - A message is deleted by the user
	 * - An error message is cleared
	 * - A message is reverted/regenerated
	 */
	function deleteMessageById(messageId: string) {
		messages = messages.filter((m) => m.info.id !== messageId);
	}

	/**
	 * Safely parses JSON data from an SSE event using ArkType validation
	 *
	 * @param event - The MessageEvent from EventSource
	 * @returns Parsed and validated event data or null if parsing/validation fails
	 */
	function parseEventData(event: MessageEvent) {
		// Define error discriminated union
		const errorType = type({
			data: {
				message: 'string',
				providerID: 'string',
			},
			name: '"ProviderAuthError"',
		})
			.or({
				data: {
					message: 'string',
				},
				name: '"UnknownError"',
			})
			.or({
				data: 'Record<string, unknown>',
				name: '"MessageOutputLengthError"',
			})
			.or({
				data: 'Record<string, unknown>',
				name: '"MessageAbortedError"',
			});

		// Define file part source discriminated union
		const filePartSourceType = type({
			path: 'string',
			text: {
				end: 'number',
				start: 'number',
				value: 'string',
			},
			type: '"file"',
		}).or({
			kind: 'number',
			name: 'string',
			path: 'string',
			range: {
				end: {
					character: 'number',
					line: 'number',
				},
				start: {
					character: 'number',
					line: 'number',
				},
			},
			text: {
				end: 'number',
				start: 'number',
				value: 'string',
			},
			type: '"symbol"',
		});

		// Define message type discriminated union
		const messageType = type({
			id: 'string',
			role: '"user"',
			sessionID: 'string',
			time: {
				created: 'number',
			},
		}).or({
			cost: 'number',
			'error?': errorType,
			id: 'string',
			modelID: 'string',
			path: {
				cwd: 'string',
				root: 'string',
			},
			providerID: 'string',
			role: '"assistant"',
			sessionID: 'string',
			'summary?': 'boolean',
			system: 'string[]',
			time: {
				'completed?': 'number',
				created: 'number',
			},
			tokens: {
				cache: {
					read: 'number',
					write: 'number',
				},
				input: 'number',
				output: 'number',
				reasoning: 'number',
			},
		});

		// Define part type discriminated union
		const partType = type({
			id: 'string',
			messageID: 'string',
			sessionID: 'string',
			'synthetic?': 'boolean',
			text: 'string',
			'time?': {
				'end?': 'number',
				start: 'number',
			},
			type: '"text"',
		})
			.or({
				'filename?': 'string',
				id: 'string',
				messageID: 'string',
				mime: 'string',
				sessionID: 'string',
				'source?': filePartSourceType,
				type: '"file"',
				url: 'string',
			})
			.or({
				callID: 'string',
				id: 'string',
				messageID: 'string',
				sessionID: 'string',
				state: type({
					status: '"pending"',
				})
					.or({
						'input?': 'unknown',
						'metadata?': 'Record<string, unknown>',
						status: '"running"',
						time: {
							start: 'number',
						},
						'title?': 'string',
					})
					.or({
						title: 'string',
						input: 'Record<string, unknown>',
						metadata: 'Record<string, unknown>',
						output: 'string',
						status: '"completed"',
						time: {
							end: 'number',
							start: 'number',
						},
					})
					.or({
						error: 'string',
						input: 'Record<string, unknown>',
						status: '"error"',
						time: {
							end: 'number',
							start: 'number',
						},
					}),
				tool: 'string',
				type: '"tool"',
			})
			.or({
				id: 'string',
				messageID: 'string',
				sessionID: 'string',
				type: '"step-start"',
			})
			.or({
				cost: 'number',
				id: 'string',
				messageID: 'string',
				sessionID: 'string',
				tokens: {
					cache: {
						read: 'number',
						write: 'number',
					},
					input: 'number',
					output: 'number',
					reasoning: 'number',
				},
				type: '"step-finish"',
			})
			.or({
				id: 'string',
				messageID: 'string',
				sessionID: 'string',
				snapshot: 'string',
				type: '"snapshot"',
			});

		// Define the comprehensive event type as a discriminated union
		const sseEventType = type('string.json.parse').to(
			type({
				properties: {
					info: messageType,
				},
				type: '"message.updated"',
			})
				.or({
					properties: {
						part: partType,
					},
					type: '"message.part.updated"',
				})
				.or({
					properties: {
						messageID: 'string',
						sessionID: 'string',
					},
					type: '"message.removed"',
				})
				.or({
					properties: {
						sessionID: 'string',
					},
					type: '"session.idle"',
				})
				.or({
					properties: {
						content: 'unknown',
						key: 'string',
					},
					type: '"storage.write"',
				}),
		);

		const result = sseEventType(event.data);
		if (result instanceof type.errors) {
			console.error('Failed to parse/validate SSE event:', result.summary);
			return null;
		}

		return result;
	}

	// Subscribe to reactive updates
	const subscribe = createSubscriber((update) => {
		if (eventSource) {
			eventSource.close();
		}

		// Construct SSE URL with authentication
		const sseUrl = new URL('/event', assistant().url);
		eventSource = new EventSource(sseUrl.toString());

		// Handle all SSE events (server sends everything as 'message' events)
		eventSource.onmessage = (event) => {
			const eventData = parseEventData(event);
			if (!eventData) return;

			// Route events based on type
			switch (eventData.type) {
				case 'message.part.updated': {
					const data = eventData satisfies EventMessagePartUpdated;
					if (data.properties.part.sessionID === sessionId()) {
						mergeStreamingPart(
							data.properties.part.messageID,
							data.properties.part,
						);
						update();
					}
					break;
				}

				case 'message.removed': {
					const data = eventData satisfies EventMessageRemoved;
					if (data.properties.sessionID === sessionId()) {
						deleteMessageById(data.properties.messageID);
						update();
					}
					break;
				}

				case 'message.updated': {
					const data = eventData satisfies EventMessageUpdated;
					if (data.properties.info.sessionID === sessionId()) {
						upsertMessage(data.properties.info);
						update();
					}
					break;
				}

				case 'session.idle':
					// Session became inactive after predetermined idle time
					// Payload: { sessionID: string }
					// Used to update UI status or perform cleanup tasks
					break;

				case 'storage.write':
					// Data was successfully written to persistent storage
					// Payload: { key: string, content: any }
					// Notification that data has been saved - ignore for UI updates
					break;

				default:
					console.warn('Unhandled event type:', eventData.type);
					break;
			}
		};

		// Handle connection errors
		eventSource.onerror = (error) => {
			console.error(
				'SSE connection error:',
				error,
				'ReadyState:',
				eventSource?.readyState,
			);
			if (eventSource?.readyState === EventSource.CLOSED) {
				console.error('SSE connection closed unexpectedly');
			}
			// TODO: Implement exponential backoff reconnection
		};

		// Cleanup
		return () => {
			if (eventSource) {
				eventSource.close();
				eventSource = null;
			}
		};
	});

	return {
		get value() {
			subscribe();
			return messages;
		},
	};
}

/**
 * Determines if an assistant message is still being generated/streamed
 *
 * @param message - The message to check
 * @returns True if the message is an assistant message without a completion timestamp
 *
 * @remarks
 * Assistant messages have a `time.completed` field that is:
 * - `undefined` while the message is being generated
 * - Set to a timestamp when generation completes
 *
 * @example
 * ```ts
 * if (isMessageProcessing(lastMessage)) {
 *   showTypingIndicator();
 * }
 * ```
 */
export function isMessageProcessing(
	message: AssistantMessage | MessageInfo,
): boolean {
	if (message.role !== 'assistant') return false;
	return !('completed' in message.time && message.time.completed);
}

/**
 * Checks if any message in the session is currently being processed
 *
 * @param messages - Array of messages to check
 * @returns True if at least one assistant message is still processing
 *
 * @remarks
 * Useful for:
 * - Disabling the input while AI is responding
 * - Showing session-level loading states
 * - Preventing concurrent message submissions
 *
 * @example
 * ```ts
 * const isProcessing = isSessionProcessing(messages.value);
 * <button disabled={isProcessing}>Send</button>
 * ```
 */
export function isSessionProcessing(messages: Message[]): boolean {
	return messages.some((msg) => isMessageProcessing(msg.info));
}
