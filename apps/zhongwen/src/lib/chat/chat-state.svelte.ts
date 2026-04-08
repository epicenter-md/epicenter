/**
 * Reactive AI chat state for Zhongwen with workspace persistence.
 *
 * Conversations and messages persist to IndexedDB via the workspace API.
 * Modeled after tab-manager's chat-state but simplified — no tool calls,
 * no encryption, no WebSocket sync.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { fromTable } from '@epicenter/svelte';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { JsonValue } from 'wellcrafted/json';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import { ZHONGWEN_SYSTEM_PROMPT } from '$lib/chat/system-prompt';
import { toUiMessage } from '$lib/chat/ui-message';
import { auth, workspace } from '$lib/client';
import {
	type ChatMessageId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
} from '$lib/workspace';

const asChatMessageId = (id: string) => id as ChatMessageId;

// ─── State Factory ───────────────────────────────────────────────────────────

function createChatState() {
	// ── Conversation List (Y.Doc-backed) ──

	const conversationsMap = fromTable(workspace.tables.conversations);
	const conversations = $derived(
		conversationsMap
			.values()
			.toArray()
			.sort((a, b) => b.updatedAt - a.updatedAt),
	);

	/** Returns the ID to activate — either the first existing conversation or a newly created default. */
	function ensureDefaultConversation(): ConversationId {
		const first = conversations[0];
		if (first) return first.id;

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

	// ── Helpers ──

	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		workspace.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	function loadMessages(conversationId: ConversationId) {
		return workspace.tables.chatMessages
			.filter((m) => m.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	// ── Handle Registry ──

	let activeConversationId = $state<ConversationId>('' as ConversationId);

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	// ── Conversation Handle Factory ──

	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');

		const metadata = $derived(conversationsMap.get(conversationId));

		const chat = createChat({
			initialMessages: loadMessages(conversationId),
			connection: fetchServerSentEvents(
				() => `${APP_URLS.API}/ai/chat`,
				() => ({
					fetchClient: auth.fetch,
					body: {
						data: {
							provider: metadata?.provider ?? DEFAULT_PROVIDER,
							model: metadata?.model ?? DEFAULT_MODEL,
							systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
						},
					},
				}),
			),
			onError: (err) => {
				console.error(
					'[zhongwen] stream error:',
					err.message,
					'conversation:',
					conversationId,
				);
			},
			onFinish: (message) => {
				workspace.tables.chatMessages.set({
					id: asChatMessageId(message.id),
					conversationId,
					role: 'assistant',
					parts: message.parts as JsonValue[],
					createdAt: message.createdAt?.getTime() ?? Date.now(),
					_v: 1,
				});
				workspace.tables.conversations.update(conversationId, {
					updatedAt: Date.now(),
				});
			},
		});

		return {
			syncMessages() {
				if (chat.isLoading) return;
				chat.setMessages(loadMessages(conversationId));
			},
			get id() {
				return conversationId;
			},

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

			get messages() {
				return chat.messages;
			},

			get isLoading() {
				return chat.isLoading;
			},

			get error() {
				return chat.error;
			},

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			sendMessage(content: string) {
				if (!content.trim()) return;
				const userMessageId = generateChatMessageId();

				// Send to client FIRST so isLoading=true before the
				// observer fires refreshFromDoc (which skips when loading).
				void chat.sendMessage({ content, id: userMessageId });

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
					workspace.tables.chatMessages.delete(asChatMessageId(lastMessage.id));
				}
				void chat.reload();
			},

			stop() {
				chat.stop();
			},
		};
	}

	// ── Lifecycle ──

	function destroyConversation(id: ConversationId) {
		handles.get(id)?.stop();
		handles.delete(id);
	}

	function reconcileHandles() {
		for (const id of handles.keys()) {
			if (!conversationsMap.has(id)) {
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

	// ── Observers ──

	// fromTable owns the reactive data; this observer only handles
	// imperative handle lifecycle (creating/destroying chat instances).
	workspace.tables.conversations.observe(() => {
		reconcileHandles();
	});
	workspace.tables.chatMessages.observe(() => {
		handles.get(activeConversationId)?.syncMessages();
	});

	// Initialize after persistence loads
	void workspace.whenReady.then(() => {
		reconcileHandles();
		activeConversationId = ensureDefaultConversation();
	});

	reconcileHandles();

	// ── Conversation CRUD ──

	function createConversation(): ConversationId {
		const id = generateConversationId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
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
		handles.get(conversationId)?.syncMessages();
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
			switchConversation(ensureDefaultConversation());
		}
	}

	// ── Public API ──

	// Safe to assert: reconcileHandles() runs synchronously in the
	// conversations observer, so every conversation ID has a handle
	// before any $derived re-evaluates.
	const conversationList = $derived(
		conversations.map((c) => handles.get(c.id)!),
	);

	return {
		get active() {
			return handles.get(activeConversationId);
		},

		get conversationHandles() {
			return conversationList;
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo: switchConversation,

		deleteConversation,
	};
}

export const chatState = createChatState();

export type ConversationHandle = NonNullable<(typeof chatState)['active']>;
