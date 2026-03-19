/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Architecture: centralized SvelteMap stores + thin handle projections.
 *
 * Five stores hold all state, each owning one concern:
 * - `messageStore`    — per-conversation UIMessage arrays (reactive)
 * - `streamStore`     — per-conversation loading/error/status (reactive)
 * - `drafts`          — per-conversation input drafts (reactive)
 * - `dismissedErrors` — per-conversation dismissed errors (reactive)
 * - `clients`         — per-conversation ChatClient instances (non-reactive)
 *
 * `ConversationHandle` is a thin projection that reads from these stores
 * and dispatches actions. It owns no `$state` — all reactivity flows
 * through the centralized stores.
 *
 * Background streaming is free: each conversation has its own ChatClient.
 * Switching away from a streaming conversation doesn't stop it.
 *
 * @example
 * ```svelte
 * <script>
 *   import { aiChatState } from '$lib/state/chat-state.svelte';
 * </script>
 *
 * {#each aiChatState.conversations as conv (conv.id)}
 *   <button onclick={() => aiChatState.switchTo(conv.id)}>
 *     {conv.title}
 *   </button>
 * {/each}
 *
 * {#each aiChatState.active?.messages ?? [] as message (message.id)}
 *   <ChatBubble {message} />
 * {/each}
 * ```
 */

import {
	ChatClient,
	type ChatClientState,
	fetchServerSentEvents,
	type UIMessage,
} from '@tanstack/ai-client';
import { SvelteMap } from 'svelte/reactivity';
import type { JsonValue } from 'wellcrafted/json';
import {
	AVAILABLE_PROVIDERS,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/ai/providers';
import { buildDeviceConstraints, TAB_MANAGER_SYSTEM_PROMPT } from '$lib/ai/system-prompt';
import { toUiMessage } from '$lib/ai/ui-message';
import { getDeviceId } from '$lib/device/device-id';
import { remoteServerUrl } from '$lib/state/settings.svelte';
import {
	type ChatMessageId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
	workspaceClient,
	workspaceDefinitions,
	workspaceTools,
} from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type StreamState = {
	isLoading: boolean;
	error: Error | undefined;
	status: ChatClientState;
};

const DEFAULT_STREAM_STATE: StreamState = {
	isLoading: false,
	error: undefined,
	status: 'ready',
};

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

function createAiChatState() {
	// ── Conversation List (Y.Doc-backed) ──────────────────────────────

	/** Read all conversations sorted by most recently updated first. */
	const readAllConversations = (): Conversation[] =>
		workspaceClient.tables.conversations
			.getAllValid()
			.sort((a, b) => b.updatedAt - a.updatedAt);

	let conversations = $state<Conversation[]>(readAllConversations());

	/**
	 * Ensure at least one conversation exists.
	 *
	 * Called after persistence loads. Safe to call multiple times —
	 * only creates if truly empty.
	 */
	function ensureDefaultConversation(): ConversationId | undefined {
		if (conversations.length > 0) return undefined;
		const id = generateConversationId();
		const now = Date.now();
		workspaceClient.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: DEFAULT_PROVIDER,
			model: DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});
		conversations = readAllConversations();
		return id;
	}

	// ── Helpers ───────────────────────────────────────────────────────

	/** Update a conversation's fields and touch `updatedAt`. */
	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		workspaceClient.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	/** Load persisted messages for a conversation from Y.Doc. */
	function loadMessages(conversationId: ConversationId) {
		return workspaceClient.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	// ── Centralized Stores ───────────────────────────────────────────

	/** Per-conversation message arrays — written by ChatClient callbacks. */
	const messageStore = new SvelteMap<ConversationId, UIMessage[]>();

	/** Per-conversation stream state — loading, error, status. */
	const streamStore = new SvelteMap<ConversationId, StreamState>();

	/** Per-conversation input drafts — preserved across switches. */
	const drafts = new SvelteMap<ConversationId, string>();

	/** Per-conversation dismissed error messages. */
	const dismissedErrors = new SvelteMap<ConversationId, string | null>();

	/** Per-conversation ChatClient instances. Plain Map — not read in templates. */
	const clients = new Map<ConversationId, ChatClient>();
	/** Per-conversation timeout IDs for stuck 'submitted' status recovery. */
	const submittedTimers = new Map<ConversationId, ReturnType<typeof setTimeout>>();

	/** Seconds to wait for the server to begin streaming before timing out. */
	const SUBMITTED_TIMEOUT_MS = 60_000;

	/** Per-conversation handle projections (reactive — read in templates). */
	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	// ── ChatClient Factory ───────────────────────────────────────────

	/**
	 * Create a ChatClient for a conversation and wire its callbacks
	 * to the centralized stores.
	 *
	 * The connection callback reads provider/model at request time
	 * (not creation time) so changes take effect on the next send.
	 */
	function createClient(conversationId: ConversationId): ChatClient {
		const initialMessages = loadMessages(conversationId);
		messageStore.set(conversationId, initialMessages);
		streamStore.set(conversationId, { ...DEFAULT_STREAM_STATE });

		const client = new ChatClient({
			initialMessages,
			tools: workspaceTools,
			connection: fetchServerSentEvents(
				() => `${remoteServerUrl.current}/ai/chat`,
				async () => {
					const conv = conversations.find((c) => c.id === conversationId);
					const deviceId = await getDeviceId();
					return {
						credentials: 'include',
						body: {
							data: {
								provider: conv?.provider ?? DEFAULT_PROVIDER,
								model: conv?.model ?? DEFAULT_MODEL,
								conversationId,
								// Device constraints first (immutable), then base/custom prompt.
								// Constraints stay even if the conversation overrides the prompt.
								systemPrompts: [
									buildDeviceConstraints(deviceId),
									conv?.systemPrompt ?? TAB_MANAGER_SYSTEM_PROMPT,
								],
								tools: workspaceDefinitions,
							},
						},
					};
				},
			),
			onMessagesChange: (msgs) => {
				// Shallow-clone every message and part to break reference identity.
				// TanStack AI's StreamProcessor mutates tool-call parts in place
				// (output, state, approval) but creates new objects for text parts.
				// SvelteMap stores raw values without deep proxying, so Svelte 5's
				// fine-grained reactivity can't detect in-place mutations on parts.
				// Fresh references ensure keyed {#each} blocks propagate changes
				// to $derived() in child components (isRunning, isApprovalRequested).
				messageStore.set(
					conversationId,
					msgs.map((m) => ({ ...m, parts: m.parts.map((p) => ({ ...p })) })),
				);
			},
			onLoadingChange: (isLoading) => {
				console.log('[ai-chat] loading:', isLoading, 'conversation:', conversationId);
				const current = streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE;
				streamStore.set(conversationId, { ...current, isLoading });
			},
			onErrorChange: (error) => {
				if (error) console.warn('[ai-chat] error:', error.message, 'conversation:', conversationId);
				const current = streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE;
				streamStore.set(conversationId, { ...current, error });
			},
			onStatusChange: (status) => {
				console.log('[ai-chat] status:', status, 'conversation:', conversationId);
				const current = streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE;
				streamStore.set(conversationId, { ...current, status });

				// Clear any existing submitted-timeout when status changes.
				const existingTimer = submittedTimers.get(conversationId);
				if (existingTimer) {
					clearTimeout(existingTimer);
					submittedTimers.delete(conversationId);
				}

				// Start a timeout when entering 'submitted' — if the server
				// never begins streaming, auto-stop and surface an error.
				if (status === 'submitted') {
					const timer = setTimeout(() => {
						submittedTimers.delete(conversationId);
						const latest = (streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE).status;
						if (latest !== 'submitted') return;

						console.warn('[ai-chat] timeout: no response within 60 s, stopping', conversationId);
						const c = clients.get(conversationId);
						if (c) c.stop();
						streamStore.set(conversationId, {
							isLoading: false,
							error: new Error('Request timed out. The AI did not respond within 60 seconds.'),
							status: 'error',
						});
					}, SUBMITTED_TIMEOUT_MS);
					submittedTimers.set(conversationId, timer);
				}
			},
			onError: (error) => {
				console.error('[ai-chat] stream error:', error.message, 'conversation:', conversationId);
			},
			onFinish: (message) => {
				workspaceClient.tables.chatMessages.set({
					id: message.id as string as ChatMessageId,
					conversationId,
					role: 'assistant',
					parts: message.parts as JsonValue[],
					createdAt: message.createdAt?.getTime() ?? Date.now(),
					_v: 1,
				});
				updateConversation(conversationId, {});
			},
		});

		clients.set(conversationId, client);
		return client;
	}

	// ── Conversation Handle Factory ──────────────────────────────────

	/**
	 * Create a thin reactive projection for a single conversation.
	 *
	 * Reads from centralized stores — owns no `$state`. The baked-in
	 * `conversationId` means getters and actions always target the
	 * correct conversation, even from async callbacks.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		const client = createClient(conversationId);

		const metadata = $derived(
			conversations.find((c) => c.id === conversationId),
		);

		return {
			// ── Identity ──

			get id() {
				return conversationId;
			},

			// ── Y.Doc-backed metadata (derived from conversations array) ──

			get title() {
				return metadata?.title ?? 'New Chat';
			},

			get provider() {
				return metadata?.provider ?? DEFAULT_PROVIDER;
			},
			set provider(value: string) {
				const models = PROVIDER_MODELS[value as Provider];
				updateConversation(conversationId, {
					provider: value,
					model: models?.[0] ?? DEFAULT_MODEL,
				});
			},

			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			get systemPrompt() {
				return metadata?.systemPrompt;
			},

			get createdAt() {
				return metadata?.createdAt ?? 0;
			},

			get updatedAt() {
				return metadata?.updatedAt ?? 0;
			},

			get parentId() {
				return metadata?.parentId;
			},

			get sourceMessageId() {
				return metadata?.sourceMessageId;
			},

			// ── Chat state (centralized stores) ──

			get messages() {
				return messageStore.get(conversationId) ?? [];
			},

			get isLoading() {
				return (streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE)
					.isLoading;
			},

			get error() {
				return (streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE).error;
			},

			get status() {
				return (streamStore.get(conversationId) ?? DEFAULT_STREAM_STATE).status;
			},

			// ── Ephemeral UI state (centralized stores) ──

			get inputValue() {
				return drafts.get(conversationId) ?? '';
			},
			set inputValue(value: string) {
				drafts.set(conversationId, value);
			},

			get dismissedError() {
				return dismissedErrors.get(conversationId) ?? null;
			},
			set dismissedError(value: string | null) {
				dismissedErrors.set(conversationId, value);
			},

			// ── Derived convenience ──

			get lastMessagePreview() {
				const msgs = workspaceClient.tables.chatMessages
					.filter((m) => m.conversationId === conversationId)
					.sort((a, b) => b.createdAt - a.createdAt);
				const last = msgs[0];
				if (!last) return '';
				const parts = last.parts as Array<{
					type: string;
					content?: string;
				}>;
				const text = parts
					.filter((p) => p.type === 'text')
					.map((p) => p.content ?? '')
					.join('')
					.trim();
				return text.length > 60 ? `${text.slice(0, 60)}…` : text;
			},

			// ── Actions ──

			sendMessage(content: string) {
				if (!content.trim()) return;
				const userMessageId = generateChatMessageId();

				// Send to client FIRST so isLoading=true before the
				// Y.Doc observer fires refreshFromDoc (which skips
				// when loading). Without this, the observer loads the
				// user message from Y.Doc AND ChatClient appends its
				// own copy → duplicate key → Svelte crash.
				void client.sendMessage({
					content,
					id: userMessageId,
				});

				workspaceClient.tables.chatMessages.set({
					id: userMessageId,
					conversationId,
					role: 'user',
					parts: [{ type: 'text', content }],
					createdAt: Date.now(),
					_v: 1,
				});

				const conv = conversations.find((c) => c.id === conversationId);
				updateConversation(conversationId, {
					title:
						conv?.title === 'New Chat'
							? content.trim().slice(0, 50)
							: conv?.title,
				});
			},

			reload() {
				const msgs = messageStore.get(conversationId) ?? [];
				const lastMessage = msgs.at(-1);
				if (lastMessage?.role === 'assistant') {
					workspaceClient.tables.chatMessages.delete(
						lastMessage.id as string as ChatMessageId,
					);
				}
				void client.reload();
			},

			stop() {
				client.stop();
			},

			/**
			 * Respond to a tool approval request.
			 *
			 * Called when the user clicks [Allow], [Always Allow], or [Deny]
			 * on a mutation tool call in the chat. Delegates to ChatClient's
			 * `addToolApprovalResponse`, which sends the response back to the
			 * server to resume or cancel tool execution.
			 *
			 * @param approvalId - The `part.approval.id` from the ToolCallPart
			 * @param approved - `true` to allow execution, `false` to deny
			 *
			 * @example
			 * ```typescript
			 * // User clicks "Allow"
			 * handle.approveToolCall(part.approval.id, true);
			 *
			 * // User clicks "Deny"
			 * handle.approveToolCall(part.approval.id, false);
			 * ```
			 */
			approveToolCall(approvalId: string, approved: boolean) {
				void client.addToolApprovalResponse({ id: approvalId, approved });
			},

			rename(title: string) {
				updateConversation(conversationId, { title });
			},

			delete() {
				deleteConversation(conversationId);
			},
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Stop client and remove all store entries for a conversation. */
	function destroyConversation(id: ConversationId) {
		clients.get(id)?.stop();
		clients.delete(id);
		messageStore.delete(id);
		streamStore.delete(id);
		drafts.delete(id);
		dismissedErrors.delete(id);
		handles.delete(id);
	}

	/**
	 * Sync handles with the conversations array.
	 *
	 * Creates handles for new conversation IDs, destroys handles
	 * for deleted IDs. Existing handles survive — their ChatClient
	 * and ephemeral state persist.
	 */
	function reconcileHandles() {
		const currentIds = new Set(conversations.map((c) => c.id));

		for (const id of handles.keys()) {
			if (!currentIds.has(id)) {
				destroyConversation(id);
			}
		}

		for (const conv of conversations) {
			if (!handles.has(conv.id)) {
				handles.set(conv.id, createConversationHandle(conv.id));
			}
		}
	}

	/**
	 * Refresh an idle conversation's messages from Y.Doc.
	 *
	 * Skips if the conversation is currently streaming (the in-progress
	 * assistant message isn't in Y.Doc yet).
	 */
	function refreshFromDoc(conversationId: ConversationId) {
		const stream = streamStore.get(conversationId);
		if (stream?.isLoading) return;

		const client = clients.get(conversationId);
		if (!client) return;

		const msgs = loadMessages(conversationId);
		messageStore.set(conversationId, msgs);
		client.setMessagesManually(msgs);
	}

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId>(
		(conversations[0]?.id ?? '') as ConversationId,
	);

	// ── Observers ────────────────────────────────────────────────────

	const _unobserveConversations = workspaceClient.tables.conversations.observe(() => {
		conversations = readAllConversations();
		reconcileHandles();
	});

	reconcileHandles();

	void workspaceClient.whenReady.then(() => {
		conversations = readAllConversations();
		reconcileHandles();
		const newId = ensureDefaultConversation();
		if (conversations.length > 0) {
			activeConversationId = newId ?? conversations[0].id;
		}
	});

	const _unobserveChatMessages = workspaceClient.tables.chatMessages.observe(() => {
		refreshFromDoc(activeConversationId);
	});

	// ── Conversation CRUD ────────────────────────────────────────────

	function createConversation(opts?: {
		title?: string;
		parentId?: ConversationId;
		sourceMessageId?: ChatMessageId;
		systemPrompt?: string;
	}): ConversationId {
		const id = generateConversationId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		workspaceClient.tables.conversations.set({
			id,
			title: opts?.title ?? 'New Chat',
			parentId: opts?.parentId,
			sourceMessageId: opts?.sourceMessageId,
			systemPrompt: opts?.systemPrompt,
			provider: current?.provider ?? DEFAULT_PROVIDER,
			model: current?.model ?? DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});

		switchConversation(id);
		return id;
	}

	function switchConversation(conversationId: ConversationId) {
		activeConversationId = conversationId;
		refreshFromDoc(conversationId);
	}

	function deleteConversation(conversationId: ConversationId) {
		destroyConversation(conversationId);

		const msgs = workspaceClient.tables.chatMessages
			.getAllValid()
			.filter((m) => m.conversationId === conversationId);
		workspaceClient.batch(() => {
			for (const m of msgs) {
				workspaceClient.tables.chatMessages.delete(m.id);
			}
			workspaceClient.tables.conversations.delete(conversationId);
		});

		if (activeConversationId === conversationId) {
			const remaining = workspaceClient.tables.conversations
				.getAllValid()
				.sort((a, b) => b.updatedAt - a.updatedAt);
			const first = remaining[0];
			if (first) {
				switchConversation(first.id);
			} else {
				createConversation();
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	return {
		get active() {
			return handles.get(activeConversationId);
		},

		get conversations() {
			return conversations
				.map((c) => handles.get(c.id))
				.filter(
					(h): h is ReturnType<typeof createConversationHandle> =>
						h !== undefined,
				);
		},

		get(id: ConversationId) {
			return handles.get(id);
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			switchConversation(conversationId);
		},

		get availableProviders() {
			return AVAILABLE_PROVIDERS;
		},

		modelsForProvider(providerName: string): readonly string[] {
			return PROVIDER_MODELS[providerName as Provider] ?? [];
		},
	};
}

export const aiChatState = createAiChatState();

/**
 * A reactive handle for a single conversation.
 *
 * Thin projection over centralized stores — reads messages, stream state,
 * and ephemeral UI state from SvelteMap stores. Actions dispatch to the
 * conversation's ChatClient directly.
 */
export type ConversationHandle = NonNullable<
	ReturnType<(typeof aiChatState)['get']>
>;
