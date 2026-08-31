/**
 * The Epicenter Home host: one local desktop chat session; built-in apps enter
 * through one verb catalog (ADR-0080). Built-in apps mount in-process through
 * app-owned catalogs (arm A); boxed apps an upstream forces off the mesh
 * may join as local stdio MCP subprocesses (arm B, Local Books today). One
 * agent loop consumes the composed catalog and never learns where a verb lives.
 *
 * Home and its built-in apps use device-owned SQLite databases opened by one
 * desktop owner. Sign-in remains an enhancement.
 */

import {
	type AgentEngine,
	type AgentMessage,
	type AgentToolCall,
	type AgentToolDefinition,
	type Approval,
	type ConversationOptions,
	type ConversationSnapshot,
	composeToolCatalogs,
	createConversation,
	defaultApprovalDecision,
	namespaceToolCatalog,
	resolveApprovedToolCall,
	type ToolCatalog,
} from '@epicenter/agent';
import {
	createLocalSourceCatalog,
	type LocalSourceCatalogOptions,
} from './local-source-catalog.ts';
import {
	createStdioMcpCatalog,
	type StdioMcpCatalogOptions,
} from './stdio-mcp-catalog.ts';
export type HomeHostInputs = {
	/** The inference backend driving the loop (BYOK, local, or scripted). */
	engine: AgentEngine;
	/**
	 * The model id the engine serves, recorded on the conversation row
	 * (ADR-0055: a surface with one fixed model writes it and never reads it).
	 */
	model: string;
	/**
	 * Override the host-owned approval prompt. Tests use this for headless
	 * auto-approval; the shell omits it so pending mutations surface in-session.
	 */
	approval?: Approval;
	/**
	 * Spawn command for the Local Books stdio MCP server (arm B). Omitted means
	 * the host runs with the built-in apps only.
	 */
	localBooks?: StdioMcpCatalogOptions;
	/**
	 * A read-only local source to compose as one `query` verb (ADR-0115 wave 6),
	 * namespaced `imessage__`. Omitted means the host runs without a local source.
	 * The reader is injected (a fixture in tests, a real Messages reader later),
	 * so the source stays host-owned and never becomes reachable over the relay.
	 */
	localSource?: LocalSourceCatalogOptions;
};

/**
 * Everything the host needs, which no longer includes anybody's data.
 *
 * The host serves bundles and brokers credentials, and owns no application
 * data (ADR-0226). What used to arrive here was a Honeycrisp handle the host
 * had opened through a mirror declaration, a conversations table of its own, and a
 * markdown folder rendered from both; all of it was the host-owned data plane
 * ADR-0227 broke from, and none of it is a shape this product has any more.
 */
export type HomeHostOptions = HomeHostInputs;

export type PendingApproval = {
	id: string;
	toolCallId: string;
	toolName: string;
	title?: string;
	description?: string;
	input: AgentToolCall['input'];
	requestedAt: number;
};

export type HomeSessionSnapshot = {
	conversation: ConversationSnapshot;
	pendingApprovals: PendingApproval[];
	invocations: HomeInvocation[];
};

/**
 * One direct tool invocation, from command to settled outcome. This is a
 * record with a lifecycle, not an event: the host mutates `status` in place
 * and pushes a fresh snapshot. Direct invocations never touch the
 * conversation transcript; the model must not see operator-plane runs as
 * chat history.
 */
export type HomeInvocation = {
	id: string;
	toolName: string;
	status: 'running' | 'succeeded' | 'failed';
	/** The outcome's model-facing text once settled; the error text on failure. */
	content?: string;
	requestedAt: number;
	settledAt?: number;
};

/** What a session client may ask of the one host-owned session. */
export type HomeClientCommand =
	| { type: 'send'; content: string }
	| { type: 'stop' }
	| { type: 'retry' }
	| {
			/**
			 * Start a fresh session: abort any live turn and switch to a new
			 * durable conversation row. The old transcript stays in its row;
			 * reopening one is a later wave
			 * (there is no conversation list yet).
			 */
			type: 'clear';
	  }
	| {
			type: 'approve';
			requestId: string;
			approved: boolean;
			alwaysAllowSession?: boolean;
	  }
	| {
			/**
			 * Run one catalog tool directly, outside a chat turn. The call rides the
			 * same approval gate as chat (`resolveApprovedToolCall`), so a direct
			 * mutation raises the same pending approval prompt; it can never bypass
			 * mutation policy (ADR-0113).
			 */
			type: 'invoke';
			toolName: string;
			input: AgentToolCall['input'];
	  };

/**
 * Validate one already-parsed frame against the command vocabulary. The host
 * owns what a valid command is (ADR-0113); transports own only the framing
 * that produced the value.
 */
export function parseHomeCommand(
	value: unknown,
): HomeClientCommand | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const command = value as Record<string, unknown>;
	if (command.type === 'send' && typeof command.content === 'string') {
		return { type: 'send', content: command.content };
	}
	if (command.type === 'stop') return { type: 'stop' };
	if (command.type === 'retry') return { type: 'retry' };
	if (command.type === 'clear') return { type: 'clear' };
	if (
		command.type === 'approve' &&
		typeof command.requestId === 'string' &&
		typeof command.approved === 'boolean'
	) {
		return {
			type: 'approve',
			requestId: command.requestId,
			approved: command.approved,
			...(command.alwaysAllowSession === true && {
				alwaysAllowSession: true,
			}),
		};
	}
	if (
		command.type === 'invoke' &&
		typeof command.toolName === 'string' &&
		command.toolName !== '' &&
		typeof command.input === 'object' &&
		command.input !== null &&
		!Array.isArray(command.input)
	) {
		return {
			type: 'invoke',
			toolName: command.toolName,
			// Every tool input schema in the catalog is a JSON object, so the
			// vocabulary accepts only plain objects. Frames arrive from JSON.parse,
			// which makes a plain object here JSON by construction.
			input: command.input as AgentToolCall['input'],
		};
	}
	return undefined;
}

export type HomeHost = {
	/** The model-visible tool surface, for shells that list or introspect tools. */
	toolDefinitions(): AgentToolDefinition[];
	/** Read the render state owned by the host session. */
	snapshot(): HomeSessionSnapshot;
	/** Register for any conversation or approval-state change. */
	subscribe(listener: () => void): () => void;
	/** Apply one client command to the host-owned session. */
	handleCommand(command: HomeClientCommand): Promise<boolean>;
	[Symbol.asyncDispose](): Promise<void>;
};

const INVOCATION_LIMIT = 20;

/**
 * Open the built-in apps, compose their catalogs, and start the one chat
 * session over them.
 */
export async function createHomeHost(
	options: HomeHostOptions,
): Promise<HomeHost> {
	// Each namespace keeps same-named verbs distinct in the composed surface;
	// the prefix must not contain `__`. The in-process app catalogs that used to
	// open this list are gone with the data plane behind them: reaching another
	// application's rows meant the host holding that application's store.
	const catalogs: ToolCatalog[] = [];

	// A read-only local source, if one is wired: one `query` verb the host reads
	// on this machine (ADR-0115 wave 6). Stateless, so it needs no disposal and
	// no `whenLoaded`; it composes beside the in-process apps behind the one seam.
	if (options.localSource) {
		catalogs.push(
			namespaceToolCatalog(
				'imessage',
				createLocalSourceCatalog(options.localSource),
			),
		);
	}

	// Arm B: boxed apps join as stdio MCP subprocesses behind the same seam.
	const localBooks = options.localBooks
		? await createStdioMcpCatalog(options.localBooks)
		: undefined;
	if (localBooks) {
		catalogs.push(namespaceToolCatalog('localbooks', localBooks));
	}

	const tools = composeToolCatalogs(catalogs);
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const sessionApproval = createSessionApproval(notify);
	// One approval policy for the whole session: chat turns and direct
	// invocations must share it so mutation policy cannot drift by caller.
	const approval = options.approval ?? sessionApproval.approval;

	const buildConversation = (store: ConversationOptions['store']) =>
		createConversation({
			store,
			engine: options.engine,
			tools,
			approval,
			generateId: () => crypto.randomUUID(),
		});

	// The transcript lives for the session and no longer (ADR-0226). It used to
	// be live row content in a store the host owned, which is exactly the
	// application data a host must not hold; a host that wants a durable
	// transcript needs a document of its own, and that is a product decision
	// nobody has made.
	let conversation = buildConversation(createSessionMessageStore());
	// One relay subscription that survives `clear` swapping the conversation;
	// host listeners subscribe to the host, never to a conversation instance.
	let unbindConversation = conversation.subscribe(notify);

	// Direct invocations outlive no one: this controller aborts any still-running
	// invoke when the host disposes, before the catalogs go away. Settlement
	// after the abort rides the catalog honoring the signal, the same contract
	// chat turns rely on; disposal never awaits invocations.
	const invokeAbort = new AbortController();
	const invocations: HomeInvocation[] = [];
	let commandQueue = Promise.resolve();
	let disposing = false;
	const runInvocation = (toolName: string, input: AgentToolCall['input']) => {
		const invocation: HomeInvocation = {
			id: crypto.randomUUID(),
			toolName,
			status: 'running',
			requestedAt: Date.now(),
		};
		invocations.push(invocation);
		// The cap bounds settled history only, and trims on push alone: a running
		// record must stay visible until it settles, and a settling record must
		// be observable at least once, so nothing evicts on settle. A concurrent
		// burst may briefly exceed the cap; later pushes converge it.
		while (invocations.length > INVOCATION_LIMIT) {
			const evictable = invocations.findIndex(
				(candidate) => candidate.status !== 'running',
			);
			if (evictable === -1) break;
			invocations.splice(evictable, 1);
		}
		notify();
		void resolveApprovedToolCall({
			tools,
			approval,
			call: { toolCallId: invocation.id, toolName, input },
			signal: invokeAbort.signal,
		})
			// Catalogs report failures as outcomes, but an abort mid-resolve (host
			// disposal) can reject; the record must still settle.
			.catch((error) => ({
				content: error instanceof Error ? error.message : String(error),
				isError: true,
			}))
			.then((outcome) => {
				invocation.status = outcome.isError ? 'failed' : 'succeeded';
				invocation.content = outcome.content;
				invocation.settledAt = Date.now();
				notify();
			});
	};

	async function applyCommand(command: HomeClientCommand): Promise<boolean> {
		switch (command.type) {
			case 'send':
				return conversation.send(command.content);
			case 'stop':
				conversation.stop();
				sessionApproval.cancelAll();
				return true;
			case 'retry':
				conversation.retry();
				return true;
			case 'clear': {
				const alreadyBlank = conversation.snapshot().messages.length === 0;
				conversation.stop();
				sessionApproval.cancelAll();
				if (alreadyBlank) {
					notify();
					return true;
				}
				const nextConversation = buildConversation(createSessionMessageStore());
				unbindConversation();
				conversation[Symbol.dispose]();
				conversation = nextConversation;
				unbindConversation = conversation.subscribe(notify);
				notify();
				return true;
			}
			case 'approve':
				return sessionApproval.answer({
					requestId: command.requestId,
					approved: command.approved,
					alwaysAllowSession: command.alwaysAllowSession === true,
				});
			case 'invoke':
				runInvocation(command.toolName, command.input);
				return true;
			default:
				command satisfies never;
				return false;
		}
	}

	return {
		toolDefinitions() {
			return tools.definitions();
		},
		snapshot() {
			return {
				conversation: conversation.snapshot(),
				pendingApprovals: sessionApproval.pending(),
				invocations: invocations.map((invocation) => ({ ...invocation })),
			};
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		handleCommand(command) {
			if (disposing) return Promise.resolve(false);
			const result = commandQueue.then(() => applyCommand(command));
			commandQueue = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		async [Symbol.asyncDispose]() {
			// The conversation first (aborts any in-flight turn), then the
			// subprocess. Nothing here has to reach durable storage, because
			// nothing here is durable.
			disposing = true;
			await commandQueue;
			conversation.stop();
			invokeAbort.abort();
			sessionApproval.cancelAll();
			await localBooks?.[Symbol.asyncDispose]();
			conversation[Symbol.dispose]();
		},
	};
}

/**
 * The loop's message store, held in memory for one session.
 *
 * The agent loop wants somewhere to put a finished message and something to
 * hear when one lands. It used to be live row content in a store the host owned;
 * the host owns no application data now (ADR-0226), so the transcript lives as
 * long as the session that produced it and no longer.
 */
function createSessionMessageStore(): ConversationOptions['store'] {
	const messages = new Map<string, AgentMessage>();
	const listeners = new Set<() => void>();
	return {
		set(key, value) {
			messages.set(key, value);
			for (const listener of listeners) listener();
		},
		*entries() {
			for (const [key, val] of messages) yield { key, val };
		},
		observe(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		[Symbol.dispose]() {
			listeners.clear();
			messages.clear();
		},
	};
}

/**
 * The session's one approval gate: pending prompts and session-scoped grants,
 * host-local and non-durable by design (an unanswered prompt dies with the
 * process). `notify` fires on every pending-set change so attached clients
 * re-render prompts from host state, not from the socket that first saw them.
 */
function createSessionApproval(notify: () => void) {
	const pending = new Map<
		string,
		{
			prompt: PendingApproval;
			resolve(approved: boolean): void;
		}
	>();
	const sessionGrants = new Set<string>();

	const approval: Approval = {
		decide(call, definition) {
			if (sessionGrants.has(call.toolName)) return 'auto';
			return defaultApprovalDecision(call, definition);
		},
		request(call, definition) {
			const id = crypto.randomUUID();
			const prompt: PendingApproval = {
				id,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				...(definition.title !== undefined && { title: definition.title }),
				...(definition.description !== undefined && {
					description: definition.description,
				}),
				input: call.input,
				requestedAt: Date.now(),
			};
			return new Promise<boolean>((resolve) => {
				pending.set(id, { prompt, resolve });
				notify();
			});
		},
	};

	return {
		approval,
		pending() {
			return [...pending.values()].map(({ prompt }) => prompt);
		},
		answer({
			requestId,
			approved,
			alwaysAllowSession,
		}: {
			requestId: string;
			approved: boolean;
			alwaysAllowSession: boolean;
		}) {
			const entry = pending.get(requestId);
			if (!entry) return false;
			pending.delete(requestId);
			if (approved && alwaysAllowSession) {
				sessionGrants.add(entry.prompt.toolName);
			}
			entry.resolve(approved);
			notify();
			return true;
		},
		cancelAll() {
			if (pending.size === 0) return;
			const entries = [...pending.values()];
			pending.clear();
			for (const entry of entries) entry.resolve(false);
			notify();
		},
	};
}
