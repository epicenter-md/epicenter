/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Architecture: self-contained ConversationHandles backed by `createChat`.
 *
 * Each ConversationHandle owns a `createChat` instance from `@tanstack/ai-svelte`
 * which manages reactive state internally via Svelte 5 runes. Domain logic
 * (workspace persistence, title updates, tool approval) is layered on top.
 *
 * Background streaming is free: each conversation has its own chat instance.
 * Switching away from a streaming conversation doesn't stop it.
 *
 * @example
 * ```svelte
 * <script>
 *   import { aiChatState } from '$lib/chat/chat-state.svelte';
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

import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { fromTable } from '@epicenter/svelte';
import { createAiChatFetch } from '@epicenter/svelte-utils/auth';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { JsonValue } from 'wellcrafted/json';
import {
	AVAILABLE_PROVIDERS,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { toUiMessage } from '$lib/chat/ui-message';
import { auth, workspace, workspaceAiTools } from '$lib/client';
import { getDeviceId } from '$lib/device/device-id';
import {
	type ChatMessageId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
} from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

function createAiChatState() {
	// ── Conversation List (Y.Doc-backed) ──────────────────────────────

	const conversationsMap = fromTable(workspace.tables.conversations);
	const conversations = $derived(
		conversationsMap
			.values()
			.toArray()
			.sort((a, b) => b.updatedAt - a.updatedAt),
	);

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
		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: DEFAULT_PROVIDER,
			model: DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});
		return id;
	}

	// ── Helpers ───────────────────────────────────────────────────────

	/** Update a conversation's fields and touch `updatedAt`. */
	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		workspace.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	/** Load persisted messages for a conversation from Y.Doc. */
	function loadMessages(conversationId: ConversationId) {
		return workspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	// ── Handle Registry ──────────────────────────────────────────────

	/** Per-conversation handle projections (reactive — read in templates). */
	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	/** Internal lifecycle closures — not exposed on ConversationHandle. */
	const destroyFns = new Map<ConversationId, () => void>();
	const refreshFns = new Map<ConversationId, () => void>();

	// ── Conversation Handle Factory ──────────────────────────────────

	/**
	 * Create a self-contained reactive handle for a single conversation.
	 *
	 * Uses `createChat` from `@tanstack/ai-svelte` for reactive state
	 * management. Domain logic (workspace persistence, tool approval,
	 * title updates) is layered on top.
	 *
	 * The baked-in `conversationId` means getters and actions always target
	 * the correct conversation, even from async callbacks.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		const metadata = $derived(conversationsMap.get(conversationId));

		const chat = createChat({
			initialMessages: loadMessages(conversationId),
			tools: workspaceAiTools.tools,
			connection: fetchServerSentEvents(
				() => `${remoteServerUrl.current}/ai/chat`,
				async () => {
					const deviceId = await getDeviceId();
					return {
						fetchClient: createAiChatFetch(auth.fetch),
						body: {
							data: {
								provider: metadata?.provider ?? DEFAULT_PROVIDER,
								model: metadata?.model ?? DEFAULT_MODEL,
								conversationId,
								systemPrompts: [
									buildDeviceConstraints(deviceId),
									metadata?.systemPrompt ?? TAB_MANAGER_SYSTEM_PROMPT,
								],
								tools: workspaceAiTools.definitions,
							},
						},
					};
				},
			),
			onError: (err) => {
				console.error(
					'[ai-chat] stream error:',
					err.message,
					'conversation:',
					conversationId,
				);
			},
			onFinish: (message) => {
				workspace.tables.chatMessages.set({
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

		// Register internal lifecycle closures
		destroyFns.set(conversationId, () => chat.stop());
		refreshFns.set(conversationId, () => {
			if (chat.isLoading) return;
			chat.setMessages(loadMessages(conversationId));
		});

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

			// ── Chat state (from createChat) ──

			get messages() {
				return chat.messages;
			},

			get isLoading() {
				return chat.isLoading;
			},

			get error() {
				return chat.error;
			},

			get status() {
				return chat.status;
			},

			/**
			 * Whether the last error was a 402 (credits exhausted).
			 * UI should show an upgrade prompt when true.
			 */
			get isCreditsExhausted() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'InsufficientCredits'
				);
			},

			get isUnauthorized() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'Unauthorized'
				);
			},

			get isModelRestricted() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'ModelRequiresPaidPlan'
				);
			},

			// ── Ephemeral UI state ──

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			get dismissedError() {
				return dismissedError;
			},
			set dismissedError(value: string | null) {
				dismissedError = value;
			},

			// ── Derived convenience ──

			get lastMessagePreview() {
				const msgs = workspace.tables.chatMessages
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

				// Send to chat FIRST so isLoading=true before the
				// Y.Doc observer fires refreshFromDoc (which skips
				// when loading). Without this, the observer loads the
				// user message from Y.Doc AND the chat appends its
				// own copy → duplicate key → Svelte crash.
				void chat.sendMessage({
					content,
					id: userMessageId,
				});

				workspace.tables.chatMessages.set({
					id: userMessageId,
					conversationId,
					role: 'user',
					parts: [{ type: 'text', content }],
					createdAt: Date.now(),
					_v: 1,
				});

				updateConversation(conversationId, {
					title:
						metadata?.title === 'New Chat'
							? content.trim().slice(0, 50)
							: metadata?.title,
				});
			},

			reload() {
				const lastMessage = chat.messages.at(-1);
				if (lastMessage?.role === 'assistant') {
					workspace.tables.chatMessages.delete(
						lastMessage.id as string as ChatMessageId,
					);
				}
				void chat.reload();
			},

			stop() {
				chat.stop();
			},

			approveToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: true });
			},

			denyToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: false });
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

	/** Stop client and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		destroyFns.get(id)?.();
		destroyFns.delete(id);
		refreshFns.delete(id);
		handles.delete(id);
	}

	/**
	 * Sync handles with the conversationsMap.
	 *
	 * Creates handles for new conversation IDs, destroys handles
	 * for deleted IDs. Existing handles survive — their chat instance
	 * and ephemeral state persist.
	 */
	function reconcileHandles() {
		for (const id of handles.keys()) {
			if (!conversationsMap.has(id as string)) {
				destroyConversation(id);
			}
		}

		for (const id of conversationsMap.keys()) {
			const convId = id as ConversationId;
			if (!handles.has(convId)) {
				handles.set(convId, createConversationHandle(convId));
			}
		}
	}

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId>('' as ConversationId);

	// ── Observers ────────────────────────────────────────────────────────────

	const _unobserveConversations = workspace.tables.conversations.observe(() => {
		reconcileHandles();
	});
	const _unobserveChatMessages = workspace.tables.chatMessages.observe(() => {
		refreshFns.get(activeConversationId)?.();
	});

	// Initialize after persistence loads
	void workspace.whenReady.then(() => {
		reconcileHandles();
		const newId = ensureDefaultConversation();
		if (conversations.length > 0) {
			activeConversationId = newId ?? conversations[0].id;
		}
	});

	reconcileHandles();

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

		workspace.tables.conversations.set({
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
		refreshFns.get(conversationId)?.();
	}

	function deleteConversation(conversationId: ConversationId) {
		destroyConversation(conversationId);

		const msgs = workspace.tables.chatMessages
			.getAllValid()
			.filter((m) => m.conversationId === conversationId);
		workspace.batch(() => {
			for (const m of msgs) {
				workspace.tables.chatMessages.delete(m.id);
			}
			workspace.tables.conversations.delete(conversationId);
		});

		if (activeConversationId === conversationId) {
			const remaining = workspace.tables.conversations
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

	const conversationList = $derived(
		conversations
			.map((c) => handles.get(c.id))
			.filter(
				(h): h is ReturnType<typeof createConversationHandle> =>
					h !== undefined,
			),
	);

	return {
		get active() {
			return handles.get(activeConversationId);
		},

		get conversations() {
			return conversationList;
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

		/** URL to the billing page for credit upgrades. */
		get billingUrl() {
			return `${remoteServerUrl.current}/billing`;
		},
	};
}

export const aiChatState = createAiChatState();

/** A reactive handle for a single conversation backed by `createChat`. */
export type ConversationHandle = NonNullable<
	ReturnType<(typeof aiChatState)['get']>
>;
