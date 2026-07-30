import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/** Merge catalogs using first-wins ownership for duplicate tool names. */
export function composeToolCatalogs(
	source: readonly ToolCatalog[] | (() => readonly ToolCatalog[]),
): ToolCatalog {
	const catalogs: () => readonly ToolCatalog[] =
		typeof source === 'function' ? source : () => source;

	function definitions(): AgentToolDefinition[] {
		const byName = new Map<string, AgentToolDefinition>();
		for (const catalog of catalogs()) {
			for (const definition of catalog.definitions()) {
				if (!byName.has(definition.name)) {
					byName.set(definition.name, definition);
				}
			}
		}
		return [...byName.values()];
	}

	async function resolve(
		call: AgentToolCall,
		signal: AbortSignal,
	): Promise<AgentToolOutcome> {
		for (const catalog of catalogs()) {
			const owns = catalog
				.definitions()
				.some((definition) => definition.name === call.toolName);
			if (owns) return catalog.resolve(call, signal);
		}
		return {
			content: `No tool named ${call.toolName} is available.`,
			isError: true,
		};
	}

	return { definitions, resolve };
}
