import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { APP_URLS } from '@epicenter/constants/vite';
import { fromTable } from '@epicenter/svelte';
import { createAiChatFetch } from '@epicenter/svelte/auth';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import type { JsonValue } from 'wellcrafted/json';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { toUiMessage } from '$lib/chat/ui-message';
import { auth, workspace, workspaceAiTools } from '$lib/client';
import { skillState } from '$lib/state/skill-state.svelte';
import {
	type ChatMessageId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
} from '$lib/workspace/definition';

function getStringValue(value: JsonValue | undefined, fallback: string) {
	return typeof value === 'string' ? value : fallback;
}

function getNumberValue(value: JsonValue | undefined, fallback = 0) {
	return typeof value === 'number' ? value : fallback;
}

function createAiChatState() {
	const conversationsMap = fromTable(workspace.tables.conversations);
	const conversations = $derived(
		conversationsMap
			.values()
			.toArray()
			.sort(
				(a, b) => getNumberValue(b.updatedAt) - getNumberValue(a.updatedAt),
			),
	);

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
			.filter((message) => message.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	const handles = new Map<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();
	const destroyFns = new Map<ConversationId, () => void>();
	const refreshFns = new Map<ConversationId, () => void>();

	function createConversationHandle(conversationId: ConversationId) {
		const metadata = $derived(conversationsMap.get(conversationId));

		const chat = createChat({
			initialMessages: loadMessages(conversationId),
			tools: workspaceAiTools.tools,
			connection: fetchServerSentEvents(
				() => `${APP_URLS.API}/ai/chat`,
				async () => ({
					fetchClient: createAiChatFetch(auth.fetch),
					body: {
						data: {
							provider: metadata?.provider ?? DEFAULT_PROVIDER,
							model: metadata?.model ?? DEFAULT_MODEL,
							conversationId,
							systemPrompts: [
								OPENSIDIAN_SYSTEM_PROMPT,
								buildGlobalSkillsPrompt(
									skillState.globalSkills.map((skill) => ({
										name: skill.name,
										instructions: skill.instructions,
									})),
								),
								buildVaultSkillsPrompt(
									skillState.vaultSkills.map((skill) => ({
										name: skill.name,
										content: skill.content,
									})),
								),
							].filter(Boolean),
							tools: workspaceAiTools.definitions,
						},
					},
				}),
			),
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
			onError: (error) => {
				console.error(
					'[opensidian-ai-chat] stream error:',
					error.message,
					'conversation:',
					conversationId,
				);
			},
		});

		destroyFns.set(conversationId, () => chat.stop());
		refreshFns.set(conversationId, () => {
			if (chat.isLoading) return;
			chat.setMessages(loadMessages(conversationId));
		});

		return {
			get id() {
				return conversationId;
			},

			get title() {
				return getStringValue(metadata?.title, 'New Chat');
			},

			get provider() {
				return getStringValue(metadata?.provider, DEFAULT_PROVIDER);
			},
			set provider(value: Provider) {
				const models = PROVIDER_MODELS[value];
				updateConversation(conversationId, {
					provider: value,
					model: models[0] ?? DEFAULT_MODEL,
				});
			},

			get model() {
				return getStringValue(metadata?.model, DEFAULT_MODEL);
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			get createdAt() {
				return getNumberValue(metadata?.createdAt);
			},

			get updatedAt() {
				return getNumberValue(metadata?.updatedAt);
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

			get status() {
				return chat.status;
			},

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

			sendMessage(content: string) {
				if (!content.trim()) return;

				const userMessageId = generateChatMessageId();

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

				const currentTitle = getStringValue(metadata?.title, 'New Chat');

				updateConversation(conversationId, {
					title:
						currentTitle === 'New Chat'
							? content.trim().slice(0, 50)
							: currentTitle,
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
		};
	}

	function destroyConversation(conversationId: ConversationId) {
		destroyFns.get(conversationId)?.();
		destroyFns.delete(conversationId);
		refreshFns.delete(conversationId);
		handles.delete(conversationId);
	}

	function reconcileHandles() {
		for (const conversationId of handles.keys()) {
			if (!conversationsMap.has(conversationId as string)) {
				destroyConversation(conversationId);
			}
		}

		for (const conversationId of conversationsMap.keys()) {
			const id = conversationId as ConversationId;
			if (!handles.has(id)) {
				handles.set(id, createConversationHandle(id));
			}
		}

		const firstConversation = conversations[0];
		if (!firstConversation) return;
		if (handles.has(activeConversationId)) return;

		activeConversationId = firstConversation.id as ConversationId;
		refreshFns.get(activeConversationId)?.();
	}

	let activeConversationId = $state<ConversationId>('' as ConversationId);

	const _unobserveConversations = workspace.tables.conversations.observe(() => {
		reconcileHandles();
	});
	const _unobserveChatMessages = workspace.tables.chatMessages.observe(() => {
		refreshFns.get(activeConversationId)?.();
	});

	void workspace.whenReady.then(() => {
		void skillState.loadAllSkills();
		reconcileHandles();

		const newId = ensureDefaultConversation();
		if (newId) {
			activeConversationId = newId;
			refreshFns.get(activeConversationId)?.();
			return;
		}

		const firstConversation = conversations[0];
		if (!firstConversation) return;

		activeConversationId = firstConversation.id as ConversationId;
		refreshFns.get(activeConversationId)?.();
	});

	reconcileHandles();

	function newConversation() {
		const id = generateConversationId();
		const now = Date.now();
		const active = handles.get(activeConversationId);

		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			provider: active?.provider ?? DEFAULT_PROVIDER,
			model: active?.model ?? DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
			_v: 1,
		});

		activeConversationId = id;
		refreshFns.get(id)?.();

		return id;
	}

	const conversationList = $derived(
		conversations
			.map((conversation) => handles.get(conversation.id))
			.filter(
				(handle): handle is ReturnType<typeof createConversationHandle> =>
					handle !== undefined,
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

		get messages() {
			return handles.get(activeConversationId)?.messages ?? [];
		},

		get isLoading() {
			return handles.get(activeConversationId)?.isLoading ?? false;
		},

		get provider() {
			return handles.get(activeConversationId)?.provider ?? DEFAULT_PROVIDER;
		},
		set provider(value: Provider) {
			const active = handles.get(activeConversationId);
			if (!active) return;
			active.provider = value;
		},

		get model() {
			return handles.get(activeConversationId)?.model ?? DEFAULT_MODEL;
		},
		set model(value: string) {
			const active = handles.get(activeConversationId);
			if (!active) return;
			active.model = value;
		},

		modelsForProvider(providerName: string): readonly string[] {
			return PROVIDER_MODELS[providerName as Provider] ?? [];
		},

		sendMessage(content: string) {
			handles.get(activeConversationId)?.sendMessage(content);
		},

		approveToolCall(approvalId: string) {
			handles.get(activeConversationId)?.approveToolCall(approvalId);
		},

		denyToolCall(approvalId: string) {
			handles.get(activeConversationId)?.denyToolCall(approvalId);
		},

		stop() {
			handles.get(activeConversationId)?.stop();
		},

		reload() {
			handles.get(activeConversationId)?.reload();
		},

		newConversation,
	};
}

export const aiChatState = createAiChatState();

export type ConversationHandle = NonNullable<
	ReturnType<(typeof aiChatState)['get']>
>;
