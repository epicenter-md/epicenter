import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { isResult } from 'wellcrafted/result';
import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/**
 * Structural action shape consumed by the local catalog adapter. It matches
 * callable Epicenter actions without making this package depend on their owner.
 */
export type LocalAction = ((...args: never[]) => unknown) & {
	type: 'query' | 'mutation';
	title?: string;
	description?: string;
	input?: TSchema;
};

export type LocalActionRegistry = Record<string, LocalAction>;

type LocalActionResult = { data: unknown; error: unknown | null };

/** Adapt a fixed in-process action registry to the loop's catalog seam. */
export function createLocalToolCatalog(
	localActions: LocalActionRegistry,
): ToolCatalog {
	function definitions(): AgentToolDefinition[] {
		return Object.entries(localActions).map(([name, action]) => ({
			name,
			kind: action.type,
			...(action.title !== undefined && { title: action.title }),
			...(action.description !== undefined && {
				description: action.description,
			}),
			...(action.input !== undefined && {
				inputSchema: action.input as JsonValue,
			}),
		}));
	}

	async function resolve(call: AgentToolCall): Promise<AgentToolOutcome> {
		const action = localActions[call.toolName];
		if (!action) {
			return {
				content: `No local tool named "${call.toolName}".`,
				isError: true,
			};
		}

		if (action.input !== undefined && !Value.Check(action.input, call.input)) {
			const errors = [...Value.Errors(action.input, call.input)]
				.map((error) => {
					const path = error.instancePath.replace(/^\//, '') || '(root)';
					return `${path} ${error.message}`;
				})
				.join('; ');
			return {
				content: `Invalid action input: ${errors}`,
				isError: true,
			};
		}

		try {
			const returned =
				action.input === undefined
					? await (action as () => unknown)()
					: await (action as unknown as (input: unknown) => unknown)(
							call.input,
						);
			const result: LocalActionResult = isResult(returned)
				? (returned as LocalActionResult)
				: { data: returned, error: null };
			if (result.error !== null) {
				return {
					content: extractErrorMessage(result.error),
					isError: true,
				};
			}
			const details = (result.data ?? null) as JsonValue;
			return {
				content:
					typeof details === 'string' ? details : JSON.stringify(details),
				details,
				isError: false,
			};
		} catch (cause) {
			return { content: extractErrorMessage(cause), isError: true };
		}
	}

	return { definitions, resolve };
}
