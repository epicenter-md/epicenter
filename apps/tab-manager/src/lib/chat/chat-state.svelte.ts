/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Architecture: self-contained ConversationHandles with own `$state`.
 *
 * Each ConversationHandle owns its ChatClient instance and reactive state
 * (`$state` for messages, status, error, drafts). Callbacks on the ChatClient
 * drive `$state` reassignment — the same pattern TanStack AI's `createChat`
 * uses internally.
 *
 * Why ChatClient directly instead of `createChat` from `@tanstack/ai-svelte`?
 * TanStack AI's StreamProcessor mutates tool-call parts (`state`, `approval`,
 * `output`) in-place AFTER `onMessagesChange` returns. `createChat` sets
 * `messages = newMessages` internally, but the in-place mutations bypass
 * Svelte 5's proxy — `$derived(part.state === 'approval-requested')` never
 * fires. Direct ChatClient access lets us shallow-clone in `onMessagesChange`
 * and re-clone on status transitions to break reference identity.
 *
 * Background streaming is free: each conversation has its own ChatClient.
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
} from '$lib/chat/providers';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { toUiMessage } from '$lib/chat/ui-message';
import { getDeviceId } from '$lib/device/device-id';
import { remoteServerUrl } from '$lib/state/settings.svelte';
import {
	type ChatMessageId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
	workspace,
	workspaceDefinitions,
	workspaceTools,
} from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Milliseconds to wait for the server to begin streaming before timing out. */
const SUBMITTED_TIMEOUT_MS = 60_000;

/**
 * Clone messages that contain tool-call parts to break reference identity.
 *
 * TanStack AI's StreamProcessor mutates tool-call parts (`state`, `approval`,
 * `output`) in-place after `onMessagesChange` returns. Svelte 5's `$state`
 * proxy can't detect these mutations since they bypass the proxy. Cloning
 * creates new objects that Svelte wraps in fresh proxies.
 *
 * The `approval` nested object is deep-cloned because `updateToolCallApproval()`
 * (in TanStack AI's message-updaters) mutates the part in-place while returning
 * a new message array. The shallow `{ ...p }` copies the `approval` reference,
 * but Svelte 5's proxy may cache the old reference identity and skip re-render.
 * Deep-cloning `approval` ensures each clone is a fully independent object.
 *
 * Only assistant messages with tool-call parts need cloning — user messages
 * and text-only assistant messages are passed through unchanged.
 */
const cloneMessages = (msgs: UIMessage[]) =>
	msgs.map((m) => {
		if (m.role !== 'assistant') return m;
		const hasToolCall = m.parts.some((p) => p.type === 'tool-call');
		if (!hasToolCall) return m;
		return {
			...m,
			parts: m.parts.map((p) => {
				if (p.type !== 'tool-call') return p;
				const clone = { ...p };
				if (clone.approval) {
					clone.approval = { ...clone.approval };
				}
				return clone;
			}),
		};
	});

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

function createAiChatState() {
	// ── Conversation List (Y.Doc-backed) ──────────────────────────────

	/** Read all conversations sorted by most recently updated first. */
	const readAllConversations = (): Conversation[] =>
		workspace.tables.conversations
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
		workspace.tables.conversations.set({
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

	// ── Conversation Handle Factory ──────────────────────────────────

	/**
	 * Create a self-contained reactive handle for a single conversation.
	 *
	 * Owns its own `$state` for messages, status, error, and ephemeral UI
	 * state. Creates and owns a ChatClient whose callbacks drive the `$state`.
	 *
	 * Messages are shallow-cloned in `onMessagesChange` and re-cloned on
	 * status transitions. This breaks reference identity so Svelte 5 detects
	 * in-place mutations by TanStack AI's StreamProcessor (tool-call `state`,
	 * `approval`, `output` are set after the callback returns).
	 *
	 * The baked-in `conversationId` means getters and actions always target
	 * the correct conversation, even from async callbacks.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		// ── Own reactive state ──
		const initialMsgs = loadMessages(conversationId);
		let messages = $state<UIMessage[]>(initialMsgs);
		let status = $state<ChatClientState>('ready');
		let isLoading = $state(false);
		let error = $state<Error | undefined>(undefined);
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		/** Timeout ID for stuck 'submitted' status recovery. */
		let submittedTimer: ReturnType<typeof setTimeout> | undefined;

		// ── ChatClient (owned by this handle) ──

		const client = new ChatClient({
			initialMessages: initialMsgs,
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
				// (output, state, approval) but Svelte 5's $state proxy can't
				// detect mutations that bypass the proxy. Fresh references ensure
				// $derived() in child components (isRunning, isApprovalRequested)
				// re-evaluate correctly.
				if (import.meta.env.DEV) {
					for (const m of msgs) {
						for (const p of m.parts) {
							if (
								p.type === 'tool-call' &&
								p.state === 'approval-requested'
							) {
								console.log('[ai-chat] approval-requested part:', {
									name: p.name,
									state: p.state,
									approval: p.approval,
								});
							}
						}
					}
				}
				messages = cloneMessages(msgs);
				// Re-clone on the next microtask to capture deferred in-place
				// mutations (e.g. needsApproval set after this callback returns).
				queueMicrotask(() => {
					messages = cloneMessages(msgs);
				});
			},
			onLoadingChange: (loading) => {
				isLoading = loading;
			},
			onErrorChange: (err) => {
				error = err;
			},
			onStatusChange: (newStatus) => {
				status = newStatus;

				// Force re-clone messages on every status change. Status transitions
				// are lifecycle boundaries — by this point, all part mutations for
				// the current phase are finalized.
				messages = cloneMessages(client.getMessages());

				// Clear any existing submitted timeout when status changes.
				if (submittedTimer) {
					clearTimeout(submittedTimer);
					submittedTimer = undefined;
				}

				// Start a timeout when entering 'submitted' — if the server
				// never begins streaming, auto-stop and surface an error.
				if (newStatus === 'submitted') {
					submittedTimer = setTimeout(() => {
						submittedTimer = undefined;
						if (status !== 'submitted') return;

						console.warn(
							'[ai-chat] timeout: no response within 60 s, stopping',
							conversationId,
						);
						client.stop();
						error = new Error(
							'Request timed out. The AI did not respond within 60 seconds.',
						);
						status = 'error';
						isLoading = false;
					}, SUBMITTED_TIMEOUT_MS);
				}
			},
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

		// ── Derived metadata (from Y.Doc-backed conversations array) ──

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

			// ── Chat state (own $state) ──

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

			/**
			 * Whether the last error was a 402 (credits exhausted).
			 * UI should show an upgrade prompt when true.
			 *
			 * TanStack AI's `fetchServerSentEvents` discards the response body on
			 * non-2xx responses and throws `Error('HTTP error! status: 402 ...')`.
			 * We match on the status code since it's the only signal available.
			 * 402 is only returned by the `InsufficientCredits` path in ai-chat.ts.
			 */
			get isCreditsExhausted() {
				if (!error) return false;
				return error.message.includes('status: 402');
			},

			// ── Ephemeral UI state (own $state) ──

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

				// Send to client FIRST so isLoading=true before the
				// Y.Doc observer fires refreshFromDoc (which skips
				// when loading). Without this, the observer loads the
				// user message from Y.Doc AND ChatClient appends its
				// own copy → duplicate key → Svelte crash.
				void client.sendMessage({
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

				const conv = conversations.find((c) => c.id === conversationId);
				updateConversation(conversationId, {
					title:
						conv?.title === 'New Chat'
							? content.trim().slice(0, 50)
							: conv?.title,
				});
			},

			reload() {
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === 'assistant') {
					workspace.tables.chatMessages.delete(
						lastMessage.id as string as ChatMessageId,
					);
				}
				void client.reload();
			},

			stop() {
				client.stop();
			},

			/**
			 * Approve a tool call that requires user confirmation.
			 *
			 * Called when the user clicks [Allow] or [Always Allow] on a
			 * mutation tool call. Resumes server-side execution.
			 *
			 * @param approvalId - The `part.approval.id` from the ToolCallPart
			 *
			 * @example
			 * ```typescript
			 * handle.approveToolCall(part.approval.id);
			 * ```
			 */
			approveToolCall(approvalId: string) {
				void client.addToolApprovalResponse({ id: approvalId, approved: true });
			},

			/**
			 * Deny a tool call that requires user confirmation.
			 *
			 * Called when the user clicks [Deny] on a mutation tool call.
			 * Cancels server-side execution.
			 *
			 * @param approvalId - The `part.approval.id` from the ToolCallPart
			 *
			 * @example
			 * ```typescript
			 * handle.denyToolCall(part.approval.id);
			 * ```
			 */
			denyToolCall(approvalId: string) {
				void client.addToolApprovalResponse({ id: approvalId, approved: false });
			},

			rename(title: string) {
				updateConversation(conversationId, { title });
			},

			delete() {
				deleteConversation(conversationId);
			},

			// ── Internal (used by lifecycle functions, not by components) ──

			/** Stop client and clear timers. Called by destroyConversation. */
			destroy() {
				if (submittedTimer) clearTimeout(submittedTimer);
				client.stop();
			},

			/**
			 * Refresh messages from Y.Doc into the ChatClient.
			 *
			 * Skips if the conversation is currently streaming (the in-progress
			 * assistant message isn't in Y.Doc yet). A single call to
			 * `setMessagesManually` is sufficient — it triggers `onMessagesChange`
			 * which updates the `$state` automatically via cloning.
			 */
			refreshFromDoc() {
				if (isLoading) return;
				const msgs = loadMessages(conversationId);
				client.setMessagesManually(msgs);
			},
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Stop client and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		handles.get(id)?.destroy();
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

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId>('' as ConversationId);

	// ── Observers ────────────────────────────────────────────────────────────

	const _unobserveConversations = workspace.tables.conversations.observe(() => {
		conversations = readAllConversations();
		reconcileHandles();
	});
	const _unobserveChatMessages = workspace.tables.chatMessages.observe(() => {
		handles.get(activeConversationId)?.refreshFromDoc();
	});

	// Initialize after persistence loads
	void workspace.whenReady.then(() => {
		conversations = readAllConversations();
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
		handles.get(conversationId)?.refreshFromDoc();
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

		/** URL to the billing page for credit upgrades. */
		get billingUrl() {
			return `${remoteServerUrl.current}/billing`;
		},
	};
}

export const aiChatState = createAiChatState();

/**
 * A reactive handle for a single conversation.
 *
 * Self-contained — owns its own `$state` for messages, status, error,
 * and ephemeral UI state. Driven by ChatClient callbacks with shallow-cloning
 * to ensure Svelte 5 detects in-place part mutations by the StreamProcessor.
 */
export type ConversationHandle = NonNullable<
	ReturnType<(typeof aiChatState)['get']>
>;
