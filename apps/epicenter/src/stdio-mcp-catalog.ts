/**
 * The boxed-app {@link ToolCatalog}: a co-located stdio MCP subprocess joins
 * the same catalog seam the in-process apps use (ADR-0080 arm B). Spawn the
 * server (`local-books mcp` today), run the MCP handshake, list the tools once,
 * and map each `tools/call` onto {@link ToolCatalog.resolve}. The subprocess
 * keeps its data private; the host sees verbs only.
 *
 * This is deliberately app-local, not a `@epicenter/workspace` primitive. Super
 * Chat is the first local-stdio consumer; promote it to the shared package when
 * a second consumer appears, not before.
 *
 * The projection rules mirror the gateway catalog's: a tool counts as a
 * `query` only when it publishes `readOnlyHint: true`, so an absent or false
 * hint tightens to a gated `mutation`, never loosens (ADR-0073).
 */

import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from '@epicenter/workspace/agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

type JsonValue = AgentToolCall['input'];

export type StdioMcpCatalogOptions = {
	/** The executable that starts the MCP server (e.g. `bun`). */
	command: string;
	/** Arguments to the executable (e.g. the server script plus its flags). */
	args?: string[];
	/**
	 * Extra environment for the subprocess. The SDK merges this over its
	 * safe-to-inherit defaults (HOME, PATH, ...) at spawn, so the subprocess
	 * never sees this process's full environment unless a variable is passed
	 * here explicitly.
	 */
	env?: Record<string, string>;
	/**
	 * How long to wait for the spawn + MCP handshake + first `tools/list`
	 * before giving up (ms, default 15000). Without this bound a subprocess
	 * that starts but never speaks MCP would stall host creation on the SDK's
	 * minute-long per-request timeout, twice.
	 */
	connectTimeoutMs?: number;
};

/**
 * A {@link ToolCatalog} backed by a live stdio MCP session, plus the disposer
 * that closes the session and reaps the subprocess.
 */
export type StdioMcpCatalog = ToolCatalog & {
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Spawn the stdio MCP server, run the handshake, and return a catalog whose
 * `definitions()` is the cached `tools/list` and whose `resolve()` is
 * `tools/call`. Async because the `initialize` + `tools/list` round-trip
 * happens up front, so the loop's synchronous `definitions()` needs no await.
 */
export async function createStdioMcpCatalog(
	options: StdioMcpCatalogOptions,
): Promise<StdioMcpCatalog> {
	const { connectTimeoutMs = 15_000 } = options;
	const client = new Client({ name: 'query', version: '0.0.0' });
	const transport = new StdioClientTransport({
		command: options.command,
		...(options.args !== undefined && { args: options.args }),
		...(options.env !== undefined && { env: options.env }),
	});

	const definitions = await withTimeout(
		connectTimeoutMs,
		`start stdio MCP server (${options.command})`,
		async () => {
			await client.connect(transport);
			const listed = await client.listTools();
			return listed.tools.map(toAgentToolDefinition);
		},
	).catch(async (error) => {
		// Reap the subprocess even when the handshake settled after the timeout
		// fired (otherwise it leaks), then propagate the failure.
		await client.close().catch(() => {});
		await transport.close().catch(() => {});
		throw error;
	});

	return {
		definitions: () => definitions,
		async resolve(
			call: AgentToolCall,
			signal: AbortSignal,
		): Promise<AgentToolOutcome> {
			try {
				const result = (await client.callTool(
					{ name: call.toolName, arguments: asArguments(call.input) },
					undefined,
					{ signal },
				)) as CallToolResult;
				return toToolOutcome(result);
			} catch (error) {
				return {
					content: error instanceof Error ? error.message : String(error),
					isError: true,
				};
			}
		},
		async [Symbol.asyncDispose]() {
			try {
				await client.close();
			} catch {
				// Already closed / subprocess gone: nothing to reap.
			}
		},
	};
}

/**
 * Project an MCP {@link Tool} to an {@link AgentToolDefinition}. `kind` is the
 * honest query-vs-mutation bit (ADR-0044): only a published
 * `readOnlyHint: true` earns `query`.
 */
function toAgentToolDefinition(tool: Tool): AgentToolDefinition {
	return {
		name: tool.name,
		kind: tool.annotations?.readOnlyHint === true ? 'query' : 'mutation',
		...(tool.title !== undefined && { title: tool.title }),
		...(tool.description !== undefined && { description: tool.description }),
		...(tool.inputSchema !== undefined && {
			inputSchema: tool.inputSchema as JsonValue,
		}),
	};
}

/** Run `work`, rejecting if it has not settled within `ms`. */
async function withTimeout<T>(
	ms: number,
	label: string,
	work: () => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timeout (${ms}ms): ${label}`)),
			ms,
		);
	});
	try {
		return await Promise.race([work(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** MCP `arguments` is an object; a non-object tool input is sent as `{}`. */
function asArguments(input: JsonValue): Record<string, unknown> {
	return input !== null && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

/**
 * Flatten an MCP {@link CallToolResult} into an {@link AgentToolOutcome}. Text
 * parts join into model-facing content; a result carrying non-text content also
 * keeps the raw content array as renderer details. `isError` rides the MCP flag.
 */
function toToolOutcome(result: CallToolResult): AgentToolOutcome {
	const isError = result.isError === true;
	const textParts = result.content.filter(
		(part): part is { type: 'text'; text: string } => part.type === 'text',
	);
	const allText = textParts.length === result.content.length;
	const content = allText
		? textParts.map((part) => part.text).join('\n')
		: JSON.stringify(result.content);
	return {
		content,
		...(!allText && { details: result.content as JsonValue }),
		isError,
	};
}
