/**
 * The loop's view of its tools, kept tool-agnostic: the loop knows how to offer
 * tools to the model and how to run one, never where a tool lives. A
 * {@link ToolCatalog} can be local actions, stdio MCP, or another host-specific
 * adapter; the loop does not change.
 */
import type { JsonValue } from 'wellcrafted/json';

/**
 * What the model is told about one tool. `kind` drives approval (a query runs
 * unattended; a mutation is gated, ADR-0044). The engine forwards
 * `{ name, description, inputSchema }` to the provider; the action key is the
 * tool name verbatim.
 */
export type AgentToolDefinition = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: JsonValue;
	kind: 'query' | 'mutation';
};

/** One tool call the model asked for, with its parsed input. */
export type AgentToolCall = {
	toolCallId: string;
	toolName: string;
	input: JsonValue;
};

/**
 * The outcome of running a tool. `content` is the model-facing text that gets
 * re-read in the next prompt; `details` is optional structured JSON for a UI
 * renderer (tables, reports, previews) that should not have to parse prose.
 */
export type AgentToolOutcome = {
	content: string;
	details?: JsonValue;
	isError: boolean;
};

/**
 * The tool surface the loop is handed. `definitions` is the live catalog the
 * model sees each step; `resolve` runs one call and returns its outcome. A loop
 * with no tools (Vocab) gets {@link NO_TOOLS}.
 */
export type ToolCatalog = {
	definitions(): AgentToolDefinition[];
	resolve(call: AgentToolCall, signal: AbortSignal): Promise<AgentToolOutcome>;
};

/**
 * Run one tool call through the shared approval gate. Chat turns and direct
 * invocations must share this path so mutation policy cannot drift by caller.
 */
export async function resolveApprovedToolCall({
	tools,
	approval,
	call,
	signal,
}: {
	tools: ToolCatalog;
	approval: Approval;
	call: AgentToolCall;
	signal: AbortSignal;
}): Promise<AgentToolOutcome> {
	const definition = tools
		.definitions()
		.find((candidate) => candidate.name === call.toolName);
	// Fail closed on an unlisted name: catalog resolvers are not required to
	// police their own listings (the stdio MCP resolver forwards any name to
	// the subprocess), so reaching `resolve` without a definition would run an
	// unlisted tool with no approval decision at all.
	if (!definition) {
		return {
			content: `No tool named ${call.toolName} is available.`,
			isError: true,
		};
	}
	const decision = approval.decide(call, definition);

	if (decision === 'deny') {
		return { content: 'Denied by policy.', isError: true };
	}
	if (decision === 'ask') {
		const approved = await approval.request(call, definition);
		// The approval prompt is the one await before execution; a stop that
		// landed while it was pending must win over a late approval.
		if (signal.aborted) {
			return { content: 'Stopped before the tool ran.', isError: true };
		}
		if (!approved) return { content: 'Denied by the user.', isError: true };
	}

	return tools.resolve(call, signal);
}

/** The empty catalog: a capability-free agent offers and runs no tools. */
export const NO_TOOLS: ToolCatalog = {
	definitions: () => [],
	resolve: async (call) => ({
		content: `No tool named ${call.toolName} is available.`,
		isError: true,
	}),
};

/** Per-conversation approval policy (ADR-0044), resolved per call. */
export type ApprovalDecision = 'auto' | 'ask' | 'deny';

/**
 * Decide and, when needed, obtain approval for one call. `decide` is the
 * per-conversation policy; `request` is the synchronous in-client prompt the
 * loop awaits for an `ask` (ADR-0047: the human is present, so the loop pauses
 * rather than writing a durable approval record). `request` resolves to whether
 * the call was approved.
 */
export type Approval = {
	decide(
		call: AgentToolCall,
		definition: AgentToolDefinition,
	): ApprovalDecision;
	request(
		call: AgentToolCall,
		definition: AgentToolDefinition,
	): Promise<boolean>;
};

/**
 * The default policy: a query runs unattended, a mutation is asked. Used when a
 * conversation declares no explicit policy.
 */
export function defaultApprovalDecision(
	_call: AgentToolCall,
	definition: AgentToolDefinition,
): ApprovalDecision {
	return definition.kind === 'mutation' ? 'ask' : 'auto';
}
