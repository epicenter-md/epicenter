/**
 * Reactive AI chat state for Zhongwen.
 *
 * Simplified from tab-manager's chat-state — no Y.Doc, no tool calls.
 * Conversations are in-memory with messages persisted to localStorage.
 */

import {
	ChatClient,
	type ChatClientState,
	fetchServerSentEvents,
	type UIMessage,
} from '@tanstack/ai-client';
import { APP_URLS } from '@epicenter/constants/vite';
import { SvelteMap } from 'svelte/reactivity';
import { tokenStore } from '$lib/auth';
import {
	AVAILABLE_PROVIDERS,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import { ZHONGWEN_SYSTEM_PROMPT } from '$lib/chat/system-prompt';


// ─── Types ───────────────────────────────────────────────────────────────────

type ConversationId = string & { __brand: 'ConversationId' };

type Conversation = {
	id: ConversationId;
	title: string;
	provider: string;
	model: string;
	createdAt: number;
	updatedAt: number;
};

// ─── ID Generation ───────────────────────────────────────────────────────────

let idCounter = 0;
function generateId(): ConversationId {
	return `conv_${Date.now()}_${++idCounter}` as ConversationId;
}

function generateMessageId(): string {
	return `msg_${Date.now()}_${++idCounter}`;
}

// ─── State Factory ───────────────────────────────────────────────────────────

function createChatState() {
	let conversations = $state<Conversation[]>([]);
	let activeConversationId = $state<ConversationId>('' as ConversationId);

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	// ── Conversation Handle Factory ──

	function createConversationHandle(conversationId: ConversationId) {
		let messages = $state<UIMessage[]>([]);
		let status = $state<ChatClientState>('ready');
		let isLoading = $state(false);
		let error = $state<Error | undefined>(undefined);
		let inputValue = $state('');

		const client = new ChatClient({
			connection: fetchServerSentEvents(
				() => `${APP_URLS.API}/ai/chat`,
				() => {
					const conv = conversations.find((c) => c.id === conversationId);
					return {
						credentials: 'include',
						headers: {
							Authorization: `Bearer ${tokenStore.get()}`,
						},
						body: {
							data: {
								provider: conv?.provider ?? DEFAULT_PROVIDER,
								model: conv?.model ?? DEFAULT_MODEL,
								systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
							},
						},
					};
				},
			),
			onMessagesChange: (msgs) => {
				messages = [...msgs];
			},
			onLoadingChange: (loading) => {
				isLoading = loading;
			},
			onErrorChange: (err) => {
				error = err;
			},
			onStatusChange: (newStatus) => {
				status = newStatus;
				messages = [...client.getMessages()];
			},
			onFinish: () => {
				const conv = conversations.find((c) => c.id === conversationId);
				if (conv) {
					conv.updatedAt = Date.now();
				}
			},
		});

		const metadata = $derived(
			conversations.find((c) => c.id === conversationId),
		);

		return {
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
				const conv = conversations.find((c) => c.id === conversationId);
				if (!conv) return;
				const models = PROVIDER_MODELS[value as Provider];
				conv.provider = value;
				conv.model = models?.[0] ?? DEFAULT_MODEL;
			},

			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				const conv = conversations.find((c) => c.id === conversationId);
				if (conv) conv.model = value;
			},

			get messages() {
				return messages;
			},

			get isLoading() {
				return isLoading;
			},

			get error() {
				return error;
			},

			get status() {
				return status;
			},

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			sendMessage(content: string) {
				if (!content.trim()) return;
				const id = generateMessageId();

				void client.sendMessage({ content, id });

				const conv = conversations.find((c) => c.id === conversationId);
				if (conv && conv.title === 'New Chat') {
					conv.title = content.trim().slice(0, 50);
				}
			},

			reload() {
				void client.reload();
			},

			stop() {
				client.stop();
			},

			rename(title: string) {
				const conv = conversations.find((c) => c.id === conversationId);
				if (conv) conv.title = title;
			},

			destroy() {
				client.stop();
			},
		};
	}

	// ── Lifecycle ──

	function reconcileHandles() {
		const currentIds = new Set(conversations.map((c) => c.id));

		for (const id of handles.keys()) {
			if (!currentIds.has(id)) {
				handles.get(id)?.destroy();
				handles.delete(id);
			}
		}

		for (const conv of conversations) {
			if (!handles.has(conv.id)) {
				handles.set(conv.id, createConversationHandle(conv.id));
			}
		}
	}

	function createConversation(): ConversationId {
		const id = generateId();
		const now = Date.now();
		const current = handles.get(activeConversationId);

		conversations = [
			{
				id,
				title: 'New Chat',
				provider: current?.provider ?? DEFAULT_PROVIDER,
				model: current?.model ?? DEFAULT_MODEL,
				createdAt: now,
				updatedAt: now,
			},
			...conversations,
		];

		reconcileHandles();
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		handles.get(conversationId)?.destroy();
		handles.delete(conversationId);

		conversations = conversations.filter((c) => c.id !== conversationId);

		if (activeConversationId === conversationId) {
			const first = conversations[0];
			if (first) {
				activeConversationId = first.id;
			} else {
				createConversation();
			}
		}
	}

	// Initialize with one conversation
	createConversation();

	// ── Public API ──

	return {
		get active() {
			return handles.get(activeConversationId);
		},

		get conversations() {
			return conversations
				.map((c) => handles.get(c.id))
				.filter((h) => h !== undefined);
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			activeConversationId = conversationId;
		},

		deleteConversation,

		get availableProviders() {
			return AVAILABLE_PROVIDERS;
		},

		modelsForProvider(providerName: string): readonly string[] {
			return PROVIDER_MODELS[providerName as Provider] ?? [];
		},
	};
}

export const chatState = createChatState();

export type ConversationHandle = NonNullable<(typeof chatState)['active']>;
