import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

const SEPARATOR = '__';

/** Prefix every tool name and strip that prefix again during resolution. */
export function namespaceToolCatalog(
	prefix: string,
	catalog: ToolCatalog,
): ToolCatalog {
	const qualified = `${prefix}${SEPARATOR}`;
	return {
		definitions(): AgentToolDefinition[] {
			return catalog.definitions().map((definition) => ({
				...definition,
				name: `${qualified}${definition.name}`,
			}));
		},
		resolve(
			call: AgentToolCall,
			signal: AbortSignal,
		): Promise<AgentToolOutcome> {
			if (!call.toolName.startsWith(qualified)) {
				return Promise.resolve({
					content: `No tool named ${call.toolName} is available.`,
					isError: true,
				});
			}
			return catalog.resolve(
				{ ...call, toolName: call.toolName.slice(qualified.length) },
				signal,
			);
		},
	};
}
