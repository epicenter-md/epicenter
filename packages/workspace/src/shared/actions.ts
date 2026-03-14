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
 * - **Introspectable**: Callable functions with metadata properties for adapters
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
 * import { createWorkspace, defineQuery, defineMutation } from '@epicenter/workspace';
 * import Type from 'typebox';
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
 *       input: Type.Object({ title: Type.String() }),
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

import type { Static, TSchema } from 'typebox';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * when the type flows through `Action` (via the `Actions` constraint),
 * `any` distributes over both branches giving `[input: any] | []` — which
 * correctly allows calling with 0 arguments for no-input actions.
 *
 * When `TInput` extends `TSchema`, the handler takes validated input.
 * When `TInput` is `undefined`, the handler takes no arguments.
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = (
	...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => TOutput | Promise<TOutput>;

/**
 * Configuration for defining an action (query or mutation).
 *
 * @typeParam TInput - The input schema type (TypeBox TSchema), or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @property description - Human-readable description for introspection and documentation
 * @property input - Optional TypeBox schema for validating and typing input
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
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, TOutput>;
};

/**
 * Metadata properties attached to a callable action.
 *
 * These are the introspection properties available on the action function itself
 * (via `Object.assign`). The handler is NOT included — the action function IS
 * the handler. Call the action directly instead of accessing `.handler`.
 */
type ActionMeta<TInput extends TSchema | undefined = TSchema | undefined> = {
	type: 'query' | 'mutation';
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * A query action definition (read operation).
 *
 * Queries are callable functions with metadata properties attached.
 * They are idempotent operations that read data without side effects.
 * When exposed via the server adapter, queries map to HTTP GET requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @example
 * ```typescript
 * const getAll = defineQuery({ handler: () => client.tables.posts.getAllValid() });
 * const posts = getAll();      // call directly
 * getAll.type;                  // 'query'
 * getAll.input;                 // schema or undefined
 * ```
 *
 * @see {@link defineQuery} for creating query definitions
 */
export type Query<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = ActionHandler<TInput, TOutput> & ActionMeta<TInput> & { type: 'query' };

/**
 * A mutation action definition (write operation).
 *
 * Mutations are callable functions with metadata properties attached.
 * They are operations that modify state or have side effects.
 * When exposed via the server adapter, mutations map to HTTP POST requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @example
 * ```typescript
 * const createPost = defineMutation({
 *   input: type({ title: 'string' }),
 *   handler: ({ title }) => { client.tables.posts.upsert({ id: generateId(), title }); },
 * });
 * createPost({ title: 'Hello' }); // call directly
 * createPost.type;                 // 'mutation'
 * ```
 *
 * @see {@link defineMutation} for creating mutation definitions
 */
export type Mutation<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = ActionHandler<TInput, TOutput> & ActionMeta<TInput> & { type: 'mutation' };

/**
 * Union type of Query and Mutation action definitions.
 *
 * Use this when you need to handle any action regardless of type.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
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
	[key: string]: Action | Actions;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns a callable function with metadata properties (`type`, `input`, `description`).
 * The `type: 'query'` discriminator is attached automatically.
 * Queries map to HTTP GET requests when exposed via the server adapter.
 *
 * The returned action IS the function — call it directly. There is no `.handler` property.
 * Pass `handler` in the config; it gets promoted to the callable root.
 *
 * @example
 * ```typescript
 * const getAllPosts = defineQuery({
 *   handler: () => client.tables.posts.getAllValid(),
 * });
 * getAllPosts();       // call directly
 * getAllPosts.type;    // 'query'
 *
 * const getPost = defineQuery({
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => client.tables.posts.get(id),
 * });
 * getPost({ id: '1' }); // call directly with typed input
 * ```
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineQuery<TOutput = unknown>(
	config: ActionConfig<undefined, TOutput>,
): Query<undefined, TOutput>;
/** With input — `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, TOutput = unknown>(
	config: ActionConfig<TInput, TOutput>,
): Query<TInput, TOutput>;
export function defineQuery({ handler, ...rest }: ActionConfig): Query {
	return Object.assign(handler, {
		type: 'query' as const,
		...rest,
	}) as unknown as Query;
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
/** No input — `TInput` is explicitly `undefined`. */
export function defineMutation<TOutput = unknown>(
	config: ActionConfig<undefined, TOutput>,
): Mutation<undefined, TOutput>;
/** With input — `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, TOutput = unknown>(
	config: ActionConfig<TInput, TOutput>,
): Mutation<TInput, TOutput>;
export function defineMutation({ handler, ...rest }: ActionConfig): Mutation {
	return Object.assign(handler, {
		type: 'mutation' as const,
		...rest,
	}) as unknown as Mutation;
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Actions are callable functions with a `type` property of 'query' or 'mutation'.
 * Call the action directly — there is no `.handler` property.
 *
 * @param value - The value to check
 * @returns True if the value is an Action definition
 *
 * @example
 * ```typescript
 * if (isAction(value)) {
 *   console.log(value.type); // 'query' | 'mutation'
 *   value(input);            // call directly
 * }
 * ```
 */
export function isAction(value: unknown): value is Action {
	return (
		typeof value === 'function' &&
		'type' in value &&
		(value.type === 'query' || value.type === 'mutation')
	);
}

/**
 * Type guard to check if a value is a query action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Query definition
 */
export function isQuery(value: unknown): value is Query {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Mutation definition
 */
export function isMutation(value: unknown): value is Mutation {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Iterate over action definitions, yielding each action with its path.
 *
 * Use this for adapters (CLI, Server) that need to introspect and invoke actions.
 * Each action is callable directly — just call `action(input)`.
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
 *   registerRoute(route, async (input) => action(input));
 * }
 *
 * // In a CLI adapter
 * for (const [action, path] of iterateActions(actions)) {
 *   const command = path.join(':');
 *   cli.command(command, async (input) => action(input));
 * }
 * ```
 */
export function* iterateActions(
	actions: Actions,
	path: string[] = [],
): Generator<[Action, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			yield [value, currentPath];
		} else {
			yield* iterateActions(value as Actions, currentPath);
		}
	}
}
