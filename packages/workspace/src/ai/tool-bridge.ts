/**
 * Bridge between workspace actions and TanStack AI's tool system.
 *
 * TanStack AI needs tools in two places:
 *
 * 1. **In the browser** — `createChat({ tools })` expects an array of
 *    `AnyClientTool` objects with `execute` functions so the `ChatClient`
 *    can run tool calls locally without a server round-trip.
 *
 * 2. **On the server** — the HTTP request body needs a JSON-serializable
 *    description of each tool (name, description, input schema) so the
 *    server can forward them to the AI provider. Functions like `execute`
 *    can't travel over the wire.
 *
 * This module converts workspace `Actions` (your `defineQuery` /
 * `defineMutation` tree) into both representations at once, so you don't
 * have to build them by hand.
 *
 * @module
 */

import type { AnyClientTool, JSONSchema } from '@tanstack/ai';
import type { Action, Actions } from '../shared/actions';
import { iterateActions } from '../shared/actions';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Recursively extract all tool names from an `Actions` tree as a string literal union.
 *
 * Leaf `Action` nodes produce their key directly. Nested `Actions` objects
 * produce `"parent_child"` paths joined with `_`.
 *
 * **Constraint**: Action keys must not contain underscores, or flattened names
 * will collide (e.g. action key `"foo_bar"` vs nested path `foo → bar` both
 * produce `"foo_bar"`).
 *
 * @example
 * ```ts
 * type Names = ActionNames<typeof workspace.actions>;
 * // "tabs_search" | "tabs_list" | "tabs_close" | "windows_list" | ...
 * ```
 */
type ActionNames<T extends Actions> = {
	[K in keyof T & string]: T[K] extends Action
		? K
		: T[K] extends Actions
			? `${K}_${ActionNames<T[K]>}`
			: never;
}[keyof T & string];

/**
 * JSON-serializable description of a tool, sent to the server in the HTTP
 * request body. This is what the AI provider sees—it tells the LLM what
 * tools exist, what arguments they accept, and whether they need user
 * approval before running.
 *
 * This is the "wire" counterpart to TanStack AI's `AnyClientTool`. The
 * client tool has an `execute` function (not JSON-serializable); this type
 * has everything EXCEPT `execute`, so it can travel in a `fetch()` body.
 *
 * Includes `title` when the action declares one, so UI components can show
 * human-readable labels (e.g. "Close Tabs" instead of "tabs_close")
 * without needing a separate lookup.
 *
 * @see {@link actionsToAiTools} for how actions are converted into these.
 */
export type ToolDefinition = {
	name: string;
	title?: string;
	description: string;
	inputSchema?: NormalizedJsonSchema;
	needsApproval?: boolean;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a workspace action tree into the two representations TanStack AI
 * needs for AI-powered chat with tool calling.
 *
 * ### What you get
 *
 * - **`.tools`** — Pass these to `createChat({ tools })`. They're TanStack AI
 *   `AnyClientTool` objects with `execute` wired to your action handlers.
 *   When the LLM calls a tool, `ChatClient` runs the matching `execute`
 *   function in the browser automatically—no server round-trip needed.
 *
 * - **`.definitions`** — Send these to the server in your HTTP request body.
 *   They're the same tools minus `execute` (which can't be serialized to
 *   JSON), plus normalized input schemas. The server forwards them to the AI
 *   provider so the LLM knows what tools are available. Each definition also
 *   includes `title` when the action declares one, so UI components can show
 *   human-readable labels directly.
 *
 * ### How it works
 *
 * Your workspace actions (`defineQuery` / `defineMutation`) are a nested tree.
 * This function flattens them into a flat tool list with `_`-separated names:
 *
 * ```
 * { tabs: { close: defineMutation(...) } }  →  tool named "tabs_close"
 * { files: { read: defineQuery(...) } }      →  tool named "files_read"
 * ```
 *
 * Mutations automatically get `needsApproval: true` so the chat UI can show
 * a confirmation dialog before executing them. Queries run immediately.
 *
 * @param actions - The workspace action tree from `workspace.actions`.
 *
 * @example
 * ```ts
 * import { actionsToAiTools } from '@epicenter/workspace/ai';
 *
 * export const workspaceAiTools = actionsToAiTools(workspace.actions);
 *
 * // Pass .tools to TanStack AI's ChatClient for local execution
 * const chat = createChat({
 *   tools: workspaceAiTools.tools,
 *   connection: fetchServerSentEvents('/ai/chat', () => ({
 *     body: {
 *       data: {
 *         // Pass .definitions to the server so the LLM knows what tools exist
 *         tools: workspaceAiTools.definitions,
 *       },
 *     },
 *   })),
 * });
 *
 * // Show a friendly title in the UI when a tool call comes back
 * const title = workspaceAiTools.definitions
 *   .find(d => d.name === 'tabs_close')?.title; // → 'Close Tabs'
 * ```
 */
export function actionsToAiTools<TActions extends Actions>(
	actions: TActions,
): {
	tools: (AnyClientTool & { name: ActionNames<TActions> })[];
	definitions: ToolDefinition[];
} {
	const entries = [...iterateActions(actions)];

	const tools = entries.map(([action, path]) => ({
		__toolSide: 'client' as const,
		name: path.join(ACTION_NAME_SEPARATOR) as ActionNames<TActions>,
		description:
			action.description ??
			`${action.type}: ${path.join(ACTION_NAME_SEPARATOR)}`,
		...(action.input && { inputSchema: action.input }),
		...(action.type === 'mutation' && { needsApproval: true }),
		execute: async (args: unknown) => (action.input ? action(args) : action()),
	}));

	// Derive wire definitions directly from actions—avoids the type-widening
	// round-trip through AnyClientTool that required `as JSONSchema` casts.
	const definitions: ToolDefinition[] = entries.map(([action, path]) => ({
		name: path.join(ACTION_NAME_SEPARATOR),
		...(action.title && { title: action.title }),
		description:
			action.description ??
			`${action.type}: ${path.join(ACTION_NAME_SEPARATOR)}`,
		// Safe cast: workspace actions only accept TypeBox schemas (TSchema),
		// which ARE plain JSON Schema objects at runtime.
		...(action.input && {
			inputSchema: normalizeSchema(action.input as JSONSchema),
		}),
		...(action.type === 'mutation' && { needsApproval: true }),
	}));

	return { tools, definitions };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Separator used to join action path segments into tool names.
 *
 * Action keys must not contain this character, or flattened names will collide.
 * For example, key `"foo_bar"` and nested path `foo → bar` would both produce
 * `"foo_bar"`.
 */
const ACTION_NAME_SEPARATOR = '_';

/** JSON Schema with `properties` and `required` guaranteed present. */
type NormalizedJsonSchema = JSONSchema &
	Required<Pick<JSONSchema, 'properties' | 'required'>>;

/**
 * Normalize a JSON Schema for AI provider compatibility.
 *
 * Some providers (notably Anthropic) reject schemas with missing `properties`
 * or `required` fields. This ensures both are always present.
 */
function normalizeSchema(schema: JSONSchema): NormalizedJsonSchema {
	return {
		...schema,
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
}
