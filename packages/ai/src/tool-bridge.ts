/**
 * Bridge between Epicenter workspace actions and TanStack AI tool types.
 *
 * Converts workspace `Action` trees into two representations:
 *
 * 1. **Client tools** (`AnyClientTool[]`) — kept in the browser, with `execute`
 *    functions wired to workspace action handlers. Passed to `ChatClientOptions.tools`
 *    so the `ChatClient` can auto-execute tool calls locally.
 *
 * 2. **Tool definitions** (`ToolDefinitionPayload[]`) — stripped for the HTTP
 *    request body. Sent to the server so `chat()` knows what tools exist without
 *    needing them hardcoded. The server passes these directly to `chat({ tools })`.
 *
 * This two-representation design exists because the app does not control the
 * backend server—tools must travel over the wire as JSON in the request body.
 *
 * @module
 */

import type { Action, Actions } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import type { AnyClientTool, JSONSchema } from '@tanstack/ai';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Recursively extract all tool names from an `Actions` tree as a string literal union.
 *
 * Leaf `Action` nodes produce their key directly. Nested `Actions` objects
 * produce `"parent_child"` paths joined with `_`.
 *
 * @example
 * ```ts
 * type Names = ActionNames<typeof workspace.actions>;
 * // "tabs_search" | "tabs_list" | "tabs_close" | "windows_list" | ...
 * ```
 */
export type ActionNames<T extends Actions> = {
	[K in keyof T & string]: T[K] extends Action
		? K
		: T[K] extends Actions
			? `${K}_${ActionNames<T[K]>}`
			: never;
}[keyof T & string];

/**
 * Wire-safe tool definition sent to the server as part of the HTTP request body.
 *
 * The server receives these and passes them directly to TanStack AI's `chat({ tools })`.
 * Because the app does not control the backend, every field the server needs must be
 * included here—anything stripped is lost forever.
 *
 * This type is intentionally compatible with TanStack AI's `Tool` interface (minus
 * `execute`, which isn't JSON-serializable). The server's `chat()` function uses
 * `execute` presence to distinguish server tools from client tools—tools without
 * `execute` are treated as client tools whose calls get forwarded back to the browser.
 *
 * ```
 * ┌─ actionsToClientTools ─────────────┐     ┌─ toToolDefinitions ─────────────┐
 * │ AnyClientTool (kept in browser)    │     │ ToolDefinitionPayload (wire)    │
 * │                                    │     │                                 │
 * │ __toolSide: 'client'  ──── skip ───┼──►  │                                 │
 * │ name                  ── forward ──┼──►  │ name                            │
 * │ description           ── forward ──┼──►  │ description                     │
 * │ inputSchema?          ── normalize ┼──►  │ inputSchema? (+ properties/req) │
 * │ outputSchema?         ── forward ──┼──►  │ outputSchema?                   │
 * │ needsApproval?        ── forward ──┼──►  │ needsApproval?                  │
 * │ metadata?             ── forward ──┼──►  │ metadata?                       │
 * │ execute               ──── skip ───┼──►  │                                 │
 * └────────────────────────────────────┘     └─────────────────────────────────┘
 * ```
 *
 * ### Field rationale
 *
 * - **`name`** — Identity. The LLM and server use this to route tool calls.
 * - **`description`** — The LLM reads this to decide when to call the tool.
 * - **`inputSchema`** — The LLM uses this to generate valid arguments. Normalized
 *   with `properties` and `required` guaranteed present because some providers
 *   (notably Anthropic) reject schemas missing those fields.
 * - **`outputSchema`** — Enables server-side output validation. TanStack AI's
 *   `executeToolCalls` validates results against this when present.
 * - **`needsApproval`** — Present on all mutations. Queries never need approval.
 *   The server's `executeToolCalls` checks this to decide whether to send an
 *   `APPROVAL_REQUESTED` event or a direct `TOOL_CALL` event. Without it,
 *   actions auto-execute with no approval dialog.
 * - **`metadata`** — Pass-through `Record<string, unknown>` for server-side
 *   routing, logging, or future TanStack AI features.
 *
 * ### Fields intentionally excluded
 *
 * - **`execute`** — Functions aren't JSON-serializable. The client keeps these locally.
 * - **`__toolSide`** — `chat()` doesn't check this for routing; it uses `execute`
 *   presence instead. Omitting it saves bytes and avoids confusion.
 */
export type ToolDefinitionPayload = {
	name: string;
	/** Short, human-readable display name for UI surfaces and MCP annotations. */
	title?: string;
	description: string;
	inputSchema?: NormalizedJsonSchema;
	outputSchema?: JSONSchema;
	needsApproval?: boolean;
	metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a workspace action tree into client-side AI tools.
 *
 * Each action becomes a `ClientTool` with `__toolSide: 'client'` and its
 * handler wired as the `execute` function. Tool names are path segments
 * joined with `_` (e.g. `tabs_search`, `windows_list`).
 *
 * The returned tools serve two purposes:
 * 1. Passed to `ChatClientOptions.tools` for local auto-execution.
 * 2. Passed to {@link toToolDefinitions} to create the wire payload.
 *
 * @example
 * ```ts
 * const tools = actionsToClientTools(workspace.actions);
 *
 * // Use locally in ChatClient
 * const chat = createChat({ tools, connection: ... });
 *
 * // Send definitions to server in the request body
 * const definitions = toToolDefinitions(tools);
 * ```
 */
export function actionsToClientTools<TActions extends Actions>(
	actions: TActions,
): (AnyClientTool & { name: ActionNames<TActions> })[] {
	return [...iterateActions(actions)].map(([action, path]) => ({
		__toolSide: 'client' as const,
		name: path.join(ACTION_NAME_SEPARATOR) as ActionNames<TActions>,
		description: action.description ?? `${action.type}: ${path.join('.')}`,
		...(action.input && { inputSchema: action.input }),
		...(action.type === 'mutation' && { needsApproval: true }),
		execute: async (args: unknown) => (action.input ? action(args) : action()),
	}));
}

/**
 * Strip client tools to wire-safe definitions for the HTTP request body.
 *
 * Removes runtime-only fields (`execute`, `__toolSide`) and forwards everything
 * the server needs to pass to `chat({ tools })`. The server receives these as
 * plain JSON and uses them directly—no reconstruction needed.
 *
 * Input schemas are normalized for provider compatibility: `properties` and
 * `required` are guaranteed present (Anthropic rejects schemas without them).
 *
 * @see {@link ToolDefinitionPayload} for per-field rationale on what's forwarded and why.
 *
 * @example
 * ```ts
 * const tools = actionsToClientTools(workspace.actions);
 * const definitions = toToolDefinitions(tools);
 * // [{ name: 'tabs_search', description: '...', inputSchema?: { ... }, needsApproval?: true }]
 * ```
 */
export function toToolDefinitions(
	tools: readonly AnyClientTool[],
): ToolDefinitionPayload[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// Safe cast: our action system only accepts TypeBox schemas (TSchema),
		// which ARE plain JSON Schema objects. AnyClientTool widens the type to
		// SchemaInput (JSONSchema | StandardJSONSchemaV1), but only TypeBox flows
		// through actionsToClientTools.
		...(tool.inputSchema && {
			inputSchema: normalizeSchema(tool.inputSchema as JSONSchema),
		}),
		...(tool.outputSchema && {
			outputSchema: tool.outputSchema as JSONSchema,
		}),
		...(tool.needsApproval && {
			needsApproval: true,
		}),
		...('metadata' in tool &&
			tool.metadata && { metadata: tool.metadata as Record<string, unknown> }),
	}));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Separator used to join action path segments into tool names. */
const ACTION_NAME_SEPARATOR = '_';

/** JSON Schema with `properties` and `required` guaranteed present. */
type NormalizedJsonSchema = JSONSchema &
	Required<Pick<JSONSchema, 'properties' | 'required'>>;

/**
 * Normalize a JSON Schema for AI provider compatibility.
 *
 * Some providers (notably Anthropic) reject schemas with missing `properties`
 * or `required` fields.
 */
function normalizeSchema(schema: JSONSchema): NormalizedJsonSchema {
	return {
		...schema,
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
}
