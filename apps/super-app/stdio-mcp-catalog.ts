/**
 * A {@link ToolCatalog} backed by a CO-LOCATED stdio MCP subprocess (ADR-0080
 * arm B). This is the sibling of `@epicenter/workspace/agent`'s
 * `createMcpGatewayCatalog`: that one binds a `Client` to the relay
 * `PeerTransport` (a tool on another device, over the network); this one binds
 * the same `Client` to a `StdioClientTransport` that spawns a server on THIS
 * machine. Same `ToolCatalog` surface, same MCP `Client`; only the transport
 * differs, which is exactly the seam ADR-0073 says Epicenter owns.
 *
 * Why stdio and same-desktop: cloud-upstream apps (Local Books today, Gmail
 * next) refuse the workspace mesh by design and expose curated verbs over a
 * stdio MCP server whose private SQLite mirror never leaves the subprocess
 * (ADR-0072). The host gets verbs, never the data. The subprocess shares no
 * in-process state with the in-process Yjs apps, so arm A and arm B cannot
 * collide in-process by construction.
 *
 * Node-only: `StdioClientTransport` spawns a child process. This adapter
 * therefore lives in the host app, not the browser-safe workspace agent barrel.
 * If a second consumer appears it can promote to `@epicenter/workspace/node`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from '@epicenter/workspace/agent';
import type { JsonValue } from 'wellcrafted/json';
import { createLogger, type Logger } from 'wellcrafted/logger';

export type StdioMcpCatalogOptions = {
	/** The executable to spawn (e.g. `bun`). */
	command: string;
	/** Its arguments (e.g. `['run', '<path>/bin.ts', 'mcp']`). */
	args: string[];
	/** Extra environment for the subprocess (merged over the parent env). */
	env?: Record<string, string>;
	/** A short, `__`-free namespace label for diagnostics (e.g. `localbooks`). */
	name: string;
	/** Diagnostics sink. Defaults to a `super-app/stdio-mcp` logger. */
	logger?: Logger;
};

/** A live stdio MCP catalog plus the disposer that closes its subprocess. */
export type StdioMcpCatalog = ToolCatalog & {
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Spawn the MCP server, run the handshake, cache its `tools/list`, and return a
 * catalog whose `resolve()` is `tools/call`. Async because the `initialize` +
 * `tools/list` round-trip happens up front, so the loop's synchronous
 * `definitions()` returns the cached list with no await (mirrors
 * `createMcpGatewayCatalog`).
 */
export async function createStdioMcpCatalog(
	options: StdioMcpCatalogOptions,
): Promise<StdioMcpCatalog> {
	const {
		command,
		args,
		env,
		name,
		logger = createLogger('super-app/stdio-mcp'),
	} = options;

	const client = new Client({ name: `super-app-${name}`, version: '0.0.0' });
	const transport = new StdioClientTransport({
		command,
		args,
		env: { ...(process.env as Record<string, string>), ...env },
	});
	await client.connect(transport);
	const listed = await client.listTools();
	const definitions = listed.tools.map(toAgentToolDefinition);
	logger.info('opened stdio MCP catalog', {
		name,
		tools: definitions.length,
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
					output: error instanceof Error ? error.message : String(error),
					isError: true,
				};
			}
		},
		async [Symbol.asyncDispose]() {
			try {
				await client.close();
			} catch {
				// Already closed / subprocess gone: nothing to release.
			}
		},
	};
}

/**
 * Project an MCP {@link Tool} to an {@link AgentToolDefinition}. `kind` honours
 * ADR-0073's "never trust a foreign hint to RELAX a gate": a tool counts as a
 * `query` only when it publishes `readOnlyHint: true`, so anything unannotated
 * tightens to a gated `mutation`.
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

/** MCP `arguments` is an object; a non-object tool input is sent as `{}`. */
function asArguments(input: JsonValue): Record<string, unknown> {
	return input !== null && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

/** Flatten an MCP {@link CallToolResult} into an {@link AgentToolOutcome}. */
function toToolOutcome(result: CallToolResult): AgentToolOutcome {
	const isError = result.isError === true;
	const textParts = result.content.filter(
		(part): part is { type: 'text'; text: string } => part.type === 'text',
	);
	const allText = textParts.length === result.content.length;
	const output: JsonValue = allText
		? textParts.map((part) => part.text).join('\n')
		: (result.content as JsonValue);
	return { output, isError };
}
