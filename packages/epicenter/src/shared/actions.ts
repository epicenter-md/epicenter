/**
 * Action System v2: Closure-based handlers for Epicenter.
 *
 * This module provides the core action definition system for Epicenter.
 * Actions are typed operations (queries for reads, mutations for writes) that
 * capture their dependencies via closures at definition time.
 *
 * ## Design Pattern: Closure-Based Dependency Injection
 *
 * Actions close over their dependencies directly instead of receiving context as a parameter:
 * - Define actions **after** creating the client
 * - Handlers reference the client via closure: signature is `(input?) => output`
 * - Adapters (Server, CLI) receive both client and actions separately: `{ client, actions }`
 *
 * **Key benefits:**
 * - **Zero annotation ceremony**: TypeScript infers handler types naturally
 * - **Type-safe**: Full type inference for client and tables, not `unknown`
 * - **Simpler signatures**: `(input?) => output` instead of `(ctx, input?) => output`
 * - **Natural JavaScript**: Uses standard closures, no framework magic
 * - **Introspectable**: Plain objects with metadata for adapters
 *
 * ## Exports
 *
 * - {@link defineQuery} - Define a read operation
 * - {@link defineMutation} - Define a write operation
 * - {@link isAction}, {@link isQuery}, {@link isMutation} - Type guards for action definitions
 * - {@link iterateActions} - Traverse and introspect action definition trees
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineQuery, defineMutation } from '@epicenter/hq';
 * import { type } from 'arktype';
 *
 * // Step 1: Create the client (with all tables and extensions)
 * const client = createWorkspace({
 *   id: 'blog',
 *   tables: { posts: postsTable },
 * });
 *
 * // Step 2: Define actions that close over the client
 * export const actions = {
 *   posts: {
 *     getAll: defineQuery({
 *       handler: () => client.tables.posts.getAllValid(),
 *     }),
 *     create: defineMutation({
 *       input: type({ title: 'string' }),
 *       handler: ({ title }) => {
 *         const id = generateId();
 *         client.tables.posts.upsert({ id, title });
 *         return { id };
 *       },
 *     }),
 *   },
 * };
 *
 * // Step 3: Pass both to adapters
 * createActionsRouter({ client, actions });
 * createCLI({ client, actions });
 * ```
 *
 * @module
 */

import type {
	StandardSchemaV1,
	StandardSchemaWithJSONSchema,
} from '../shared/standard-schema/types';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for defining an action (query or mutation).
 *
 * @typeParam TInput - The input schema type (StandardSchema), or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @property description - Human-readable description for introspection and documentation
 * @property input - Optional StandardSchema for validating and typing input
 * @property output - Optional StandardSchema for output (used by adapters for serialization)
 * @property handler - The action implementation. Handlers close over their dependencies and have signature `(input?) => output`
 *
 * @remarks
 * **Closure-based design**: Handlers capture their dependencies (client, tables, extensions, etc.)
 * via closure instead of receiving context as a parameter. This means:
 * - Handlers should be defined after the client they depend on is created
 * - Dependencies are accessed through closure, not as a parameter
 * - No type annotations needed—TypeScript infers everything naturally
 *
 * This is standard JavaScript closure mechanics, not framework magic.
 *
 * @example
 * ```typescript
 * // Assuming client is defined above:
 * // const client = createWorkspace({ id: 'blog', tables: { posts: ... } });
 *
 * // Action with input - closes over client via closure
 * const config: ActionConfig<typeof inputSchema, Post> = {
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => client.tables.posts.get(id),  // client captured by closure
 * };
 *
 * // Action without input
 * const configNoInput: ActionConfig<undefined, Post[]> = {
 *   handler: () => client.tables.posts.getAllValid(),  // client captured by closure
 * };
 * ```
 */
type ActionConfig<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = {
	description?: string;
	input?: TInput;
	output?: StandardSchemaWithJSONSchema;
	handler: TInput extends StandardSchemaWithJSONSchema
		? (
				input: StandardSchemaV1.InferOutput<TInput>,
			) => TOutput | Promise<TOutput>
		: () => TOutput | Promise<TOutput>;
};

/**
 * A query action definition (read operation).
 *
 * Queries are idempotent operations that read data without side effects.
 * When exposed via the server adapter, queries map to HTTP GET requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @see {@link defineQuery} for creating query definitions
 */
export type Query<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	type: 'query';
};

/**
 * A mutation action definition (write operation).
 *
 * Mutations are operations that modify state or have side effects.
 * When exposed via the server adapter, mutations map to HTTP POST requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @see {@link defineMutation} for creating mutation definitions
 */
export type Mutation<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	type: 'mutation';
};

/**
 * Union type of Query and Mutation action definitions.
 *
 * Use this when you need to handle any action regardless of type.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 */
export type Action<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = Query<TInput, TOutput> | Mutation<TInput, TOutput>;

/**
 * A tree of action definitions, supporting arbitrary nesting.
 *
 * Actions can be organized into namespaces for better organization.
 * Each handler closes over the client and dependencies from its enclosing scope.
 *
 * @example
 * ```typescript
 * // Define after creating client: const client = createWorkspace({ ... });
 *
 * const actions: Actions = {
 *   posts: {
 *     getAll: defineQuery({
 *       handler: () => client.tables.posts.getAllValid()  // closes over client
 *     }),
 *     create: defineMutation({
 *       handler: ({ title }) => {
 *         client.tables.posts.upsert({ id: generateId(), title });
 *         return { id };
 *       }
 *     }),
 *   },
 *   users: {
 *     profile: {
 *       get: defineQuery({
 *         handler: () => client.tables.users.getCurrentProfile()  // closes over client
 *       }),
 *     },
 *   },
 * };
 * ```
 */
export type Actions = {
	[key: string]: Action<any, any> | Actions;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * The `type: 'query'` discriminator is attached automatically.
 * Queries map to HTTP GET requests when exposed via the server adapter.
 *
 * Handlers close over their dependencies (client, tables, etc.) instead of receiving
 * context as a parameter. Define queries after creating the client.
 *
 * @example
 * ```typescript
 * // Assuming client is already created:
 * // const client = createWorkspace({ ... });
 *
 * // Query without input - closes over client
 * const getAllPosts = defineQuery({
 *   handler: () => client.tables.posts.getAllValid(),
 * });
 *
 * // Query with input validation - closes over client
 * const getPost = defineQuery({
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => client.tables.posts.get(id),
 * });
 * ```
 */
export function defineQuery<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
>(config: ActionConfig<TInput, TOutput>): Query<TInput, TOutput> {
	return { type: 'query' as const, ...config };
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * The `type: 'mutation'` discriminator is attached automatically.
 * Mutations map to HTTP POST requests when exposed via the server adapter.
 *
 * Handlers close over their dependencies (client, tables, extensions, etc.) instead
 * of receiving context as a parameter. Define mutations after creating the client.
 *
 * @example
 * ```typescript
 * // Assuming client is already created:
 * // const client = createWorkspace({ ... });
 *
 * // Mutation that creates a post - closes over client
 * const createPost = defineMutation({
 *   input: type({ title: 'string' }),
 *   handler: ({ title }) => {
 *     const id = generateId();
 *     client.tables.posts.upsert({ id, title });
 *     return { id };
 *   },
 * });
 *
 * // Mutation that syncs data - closes over client and extensions
 * const syncMarkdown = defineMutation({
 *   description: 'Sync markdown files to YJS',
 *   handler: () => client.extensions.markdown.pullFromMarkdown(),
 * });
 * ```
 */
export function defineMutation<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
>(config: ActionConfig<TInput, TOutput>): Mutation<TInput, TOutput> {
	return { type: 'mutation' as const, ...config };
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Returns true if the value is an object with:
 * - A `type` property of 'query' or 'mutation'
 * - A `handler` function
 *
 * @param value - The value to check
 * @returns True if the value is an Action definition
 *
 * @example
 * ```typescript
 * if (isAction(value)) {
 *   // value is typed as Action<any, any>
 *   console.log(value.type); // 'query' | 'mutation'
 *   value.handler(input);
 * }
 * ```
 */
export function isAction(value: unknown): value is Action<any, any> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		(value.type === 'query' || value.type === 'mutation') &&
		'handler' in value &&
		typeof value.handler === 'function'
	);
}

/**
 * Type guard to check if a value is a query action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Query definition
 */
export function isQuery(value: unknown): value is Query<any, any> {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Mutation definition
 */
export function isMutation(value: unknown): value is Mutation<any, any> {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Iterate over action definitions, yielding each action with its path.
 *
 * Use this for adapters (CLI, Server) that need to introspect and invoke actions.
 * Each action's handler already has access to the client via closure, so adapters
 * just call `action.handler(input)` directly—no attachment step needed.
 *
 * @param actions - The action tree to iterate over
 * @param path - Internal parameter for tracking the current path (default: [])
 * @yields Tuples of [action, path] where path is an array of keys
 *
 * @example
 * ```typescript
 * // In a server adapter
 * for (const [action, path] of iterateActions(actions)) {
 *   const route = path.join('/');
 *   registerRoute(route, async (input) => {
 *     // Handler already has client via closure—just call it directly
 *     return await action.handler(input);
 *   });
 * }
 *
 * // In a CLI adapter
 * for (const [action, path] of iterateActions(actions)) {
 *   const command = path.join(':');
 *   cli.command(command, async (input) => {
 *     return await action.handler(input);  // Direct invocation
 *   });
 * }
 * ```
 */
export function* iterateActions(
	actions: Actions,
	path: string[] = [],
): Generator<[Action<any, any>, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			yield [value, currentPath];
		} else {
			yield* iterateActions(value as Actions, currentPath);
		}
	}
}
