import type {
	MutationFunction,
	MutationKey,
	MutationOptions,
	QueryClient,
	QueryFunction,
	QueryFunctionContext,
	QueryKey,
} from "@tanstack/query-core";
import { Err, Ok, type Result, resolve } from "../result/index.js";
import type { QueryObserverOptions } from "@tanstack/query-core";

/**
 * Input options for defining a query.
 *
 * Extends TanStack Query's QueryObserverOptions but replaces queryFn with resultQueryFn.
 * This type represents the configuration for creating a query definition with both
 * reactive and imperative interfaces for data fetching.
 *
 * @template TQueryFnData - The type of data returned by the query function
 * @template TError - The type of error that can be thrown
 * @template TData - The type of data returned by the query (after select transform)
 * @template TQueryKey - The type of the query key
 */
export type DefineQueryInput<
	TQueryFnData,
	TError,
	TData = TQueryFnData,
	TQueryKey extends QueryKey = QueryKey,
> = Omit<
	QueryObserverOptions<TQueryFnData, TError, TData, TQueryFnData, TQueryKey>,
	"queryFn"
> & {
	queryKey: TQueryKey;
	resultQueryFn: QueryFunction<Result<TQueryFnData, TError>, TQueryKey>;
};

/**
 * Output of defineQuery function.
 *
 * Provides both reactive and imperative interfaces for data fetching:
 * - `options()`: Returns config for use with createQuery() in components
 * - `fetch()`: Always attempts to fetch data (from cache if fresh, network if stale)
 * - `ensure()`: Guarantees data availability, preferring cached data (recommended for preloaders)
 *
 * @template TQueryFnData - The type of data returned by the query function
 * @template TError - The type of error that can be thrown
 * @template TData - The type of data returned by the query (after select transform)
 * @template TQueryKey - The type of the query key
 */
export type DefineQueryOutput<
	TQueryFnData,
	TError,
	TData = TQueryFnData,
	TQueryKey extends QueryKey = QueryKey,
> = {
	options: () => QueryObserverOptions<
		TQueryFnData,
		TError,
		TData,
		TQueryFnData,
		TQueryKey
	>;
	fetch: () => Promise<Result<TData, TError>>;
	ensure: () => Promise<Result<TData, TError>>;
};

/**
 * Input options for defining a mutation.
 *
 * Extends TanStack Query's MutationOptions but replaces mutationFn with resultMutationFn.
 * This type represents the configuration for creating a mutation definition with both
 * reactive and imperative interfaces for data mutations.
 *
 * @template TData - The type of data returned by the mutation
 * @template TError - The type of error that can be thrown
 * @template TVariables - The type of variables passed to the mutation
 * @template TContext - The type of context data for optimistic updates
 */
export type DefineMutationInput<
	TData,
	TError,
	TVariables = void,
	TContext = unknown,
> = Omit<MutationOptions<TData, TError, TVariables, TContext>, "mutationFn"> & {
	mutationKey: MutationKey;
	resultMutationFn: MutationFunction<Result<TData, TError>, TVariables>;
};

/**
 * Output of defineMutation function.
 *
 * Provides both reactive and imperative interfaces for data mutations:
 * - `options()`: Returns config for use with createMutation() in Svelte components
 * - `execute()`: Directly executes the mutation and returns a Result
 *
 * @template TData - The type of data returned by the mutation
 * @template TError - The type of error that can be thrown
 * @template TVariables - The type of variables passed to the mutation
 * @template TContext - The type of context data for optimistic updates
 */
export type DefineMutationOutput<
	TData,
	TError,
	TVariables = void,
	TContext = unknown,
> = {
	options: () => MutationOptions<TData, TError, TVariables, TContext>;
	execute: (variables: TVariables) => Promise<Result<TData, TError>>;
};

/**
 * Creates factory functions for defining queries and mutations bound to a specific QueryClient.
 *
 * This factory pattern allows you to create isolated query/mutation definitions that are
 * bound to a specific QueryClient instance, enabling:
 * - Multiple query clients in the same application
 * - Testing with isolated query clients
 * - Framework-agnostic query definitions
 * - Proper separation of concerns between query logic and client instances
 *
 * The returned functions handle Result types automatically, unwrapping them for TanStack Query
 * while maintaining type safety throughout your application.
 *
 * @param queryClient - The QueryClient instance to bind the factories to
 * @returns An object containing defineQuery and defineMutation functions bound to the provided client
 *
 * @example
 * ```typescript
 * // Create your query client
 * const queryClient = new QueryClient({
 *   defaultOptions: {
 *     queries: { staleTime: 5 * 60 * 1000 }
 *   }
 * });
 *
 * // Create the factory functions
 * const { defineQuery, defineMutation } = createQueryFactories(queryClient);
 *
 * // Now use defineQuery and defineMutation as before
 * const userQuery = defineQuery({
 *   queryKey: ['user', userId],
 *   resultQueryFn: () => services.getUser(userId)
 * });
 *
 * // Use in components
 * const query = createQuery(userQuery.options());
 *
 * // Or imperatively
 * const { data, error } = await userQuery.fetch();
 * ```
 */
export function createQueryFactories(queryClient: QueryClient) {
	/**
	 * Creates a query definition that bridges the gap between pure service functions and reactive UI components.
	 *
	 * This factory function is the cornerstone of our data fetching architecture. It wraps service calls
	 * with TanStack Query superpowers while maintaining type safety through Result types.
	 *
	 * ## Why use defineQuery?
	 *
	 * 1. **Dual Interface**: Provides both reactive (`.options()`) and imperative (`.fetch()`) APIs
	 * 2. **Automatic Error Handling**: Service functions return `Result<T, E>` types which are automatically
	 *    unwrapped by TanStack Query, giving you proper error states in your components
	 * 3. **Type Safety**: Full TypeScript support with proper inference for data and error types
	 * 4. **Consistency**: Every query in the app follows the same pattern, making it easy to understand
	 *
	 * @template TQueryFnData - The type of data returned by the query function
	 * @template TError - The type of error that can be thrown
	 * @template TData - The type of data returned by the query (after select transform)
	 * @template TQueryKey - The type of the query key
	 *
	 * @param options - Query configuration object
	 * @param options.queryKey - Unique key for this query (used for caching and refetching)
	 * @param options.resultQueryFn - Function that fetches data and returns a Result type
	 * @param options.* - Any other TanStack Query options (staleTime, refetchInterval, etc.)
	 *
	 * @returns Query definition object with three methods:
	 *   - `options()`: Returns config for use with createQuery() in Svelte components
	 *   - `fetch()`: Always attempts to fetch data (from cache if fresh, network if stale)
	 *   - `ensure()`: Guarantees data availability, preferring cached data (recommended for preloaders)
	 *
	 * @example
	 * ```typescript
	 * // Step 1: Define your query in the query layer
	 * const userQuery = defineQuery({
	 *   queryKey: ['users', userId],
	 *   resultQueryFn: () => services.getUser(userId), // Returns Result<User, ApiError>
	 *   staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
	 * });
	 *
	 * // Step 2a: Use reactively in a Svelte component
	 * const query = createQuery(userQuery.options());
	 * // $query.data is User | undefined
	 * // $query.error is ApiError | null
	 *
	 * // Step 2b: Use imperatively in preloaders (recommended)
	 * export const load = async () => {
	 *   const { data, error } = await userQuery.ensure();
	 *   if (error) throw error;
	 *   return { user: data };
	 * };
	 *
	 * // Step 2c: Use imperatively for explicit refresh
	 * async function refreshUser() {
	 *   const { data, error } = await userQuery.fetch();
	 *   if (error) {
	 *     console.error('Failed to fetch user:', error);
	 *   }
	 * }
	 * ```
	 */
	const defineQuery = <
		TQueryFnData,
		TError,
		TData = TQueryFnData,
		TQueryKey extends QueryKey = QueryKey,
	>(
		options: DefineQueryInput<TQueryFnData, TError, TData, TQueryKey>,
	): DefineQueryOutput<TQueryFnData, TError, TData, TQueryKey> => {
		const newOptions = {
			...options,
			queryFn: async (context: QueryFunctionContext<TQueryKey>) => {
				let result = options.resultQueryFn(context);
				if (result instanceof Promise) result = await result;
				return resolve(result);
			},
		} satisfies QueryObserverOptions<
			TQueryFnData,
			TError,
			TData,
			TQueryFnData,
			TQueryKey
		>;

		return {
			/**
			 * Returns the query options for reactive usage with TanStack Query hooks.
			 * Use this with `createQuery()` in Svelte components for automatic subscriptions.
			 * @returns The query options object configured for TanStack Query
			 */
			options: () => newOptions,

			/**
			 * Fetches data for this query using queryClient.fetchQuery().
			 *
			 * This method ALWAYS evaluates freshness and will refetch if data is stale.
			 * It wraps TanStack Query's fetchQuery method, which returns cached data if fresh
			 * or makes a network request if the data is stale or missing.
			 *
			 * **When to use fetch():**
			 * - When you explicitly want to check data freshness
			 * - For user-triggered refresh actions
			 * - When you need the most up-to-date data
			 *
			 * **For preloaders, use ensure() instead** - it's more efficient for initial data loading.
			 *
			 * @returns Promise that resolves with a Result containing either the data or an error
			 *
			 * @example
			 * // Good for user-triggered refresh
			 * const { data, error } = await userQuery.fetch();
			 * if (error) {
			 *   console.error('Failed to load user:', error);
			 * }
			 */
			async fetch(): Promise<Result<TData, TError>> {
				try {
					return Ok(
						await queryClient.fetchQuery<TQueryFnData, Error, TData, TQueryKey>(
							{
								queryKey: newOptions.queryKey,
								queryFn: newOptions.queryFn,
							},
						),
					);
				} catch (error) {
					return Err(error as TError);
				}
			},

			/**
			 * Ensures data is available for this query using queryClient.ensureQueryData().
			 *
			 * This method PRIORITIZES cached data and only calls fetchQuery internally if no cached
			 * data exists. It wraps TanStack Query's ensureQueryData method, which is perfect for
			 * guaranteeing data availability with minimal network requests.
			 *
			 * **This is the RECOMMENDED method for preloaders** because:
			 * - It returns cached data immediately if available
			 * - It updates the query client cache properly
			 * - It minimizes network requests during navigation
			 * - It ensures components have data ready when they mount
			 *
			 * **When to use ensure():**
			 * - Route preloaders and data loading functions
			 * - Initial component data requirements
			 * - When cached data is acceptable for immediate display
			 *
			 * @returns Promise that resolves with a Result containing either the data or an error
			 *
			 * @example
			 * // Perfect for preloaders
			 * export const load = async () => {
			 *   const { data, error } = await userQuery.ensure();
			 *   if (error) {
			 *     throw error;
			 *   }
			 *   return { user: data };
			 * };
			 */
			async ensure(): Promise<Result<TData, TError>> {
				try {
					return Ok(
						await queryClient.ensureQueryData<
							TQueryFnData,
							Error,
							TData,
							TQueryKey
						>({
							queryKey: newOptions.queryKey,
							queryFn: newOptions.queryFn,
						}),
					);
				} catch (error) {
					return Err(error as TError);
				}
			},
		};
	};

	/**
	 * Creates a mutation definition for operations that modify data (create, update, delete).
	 *
	 * This factory function is the mutation counterpart to defineQuery. It provides a clean way to
	 * wrap service functions that perform side effects, while maintaining the same dual interface
	 * pattern for maximum flexibility.
	 *
	 * ## Why use defineMutation?
	 *
	 * 1. **Dual Interface**: Just like queries, mutations can be used reactively or imperatively
	 * 2. **Direct Execution**: The `.execute()` method lets you run mutations without creating hooks,
	 *    perfect for event handlers and non-component code
	 * 3. **Consistent Error Handling**: Service functions return `Result<T, E>` types, ensuring
	 *    errors are handled consistently throughout the app
	 * 4. **Cache Management**: Mutations often update the cache after success (see examples)
	 *
	 * @template TData - The type of data returned by the mutation
	 * @template TError - The type of error that can be thrown
	 * @template TVariables - The type of variables passed to the mutation
	 * @template TContext - The type of context data for optimistic updates
	 *
	 * @param options - Mutation configuration object
	 * @param options.mutationKey - Unique key for this mutation (used for tracking in-flight state)
	 * @param options.resultMutationFn - Function that performs the mutation and returns a Result type
	 * @param options.* - Any other TanStack Mutation options (onSuccess, onError, etc.)
	 *
	 * @returns Mutation definition object with two methods:
	 *   - `options()`: Returns config for use with createMutation() in Svelte components
	 *   - `execute()`: Directly executes the mutation and returns a Result
	 *
	 * @example
	 * ```typescript
	 * // Step 1: Define your mutation with cache updates
	 * const createRecording = defineMutation({
	 *   mutationKey: ['recordings', 'create'],
	 *   resultMutationFn: async (recording: Recording) => {
	 *     // Call the service
	 *     const result = await services.db.createRecording(recording);
	 *     if (result.error) return Err(result.error);
	 *
	 *     // Update cache on success
	 *     queryClient.setQueryData(['recordings'], (old) =>
	 *       [...(old || []), recording]
	 *     );
	 *
	 *     return Ok(result.data);
	 *   }
	 * });
	 *
	 * // Step 2a: Use reactively in a component
	 * const mutation = createMutation(createRecording.options());
	 * // Call with: $mutation.mutate(recordingData)
	 *
	 * // Step 2b: Use imperatively in an action
	 * async function saveRecording(data: Recording) {
	 *   const { error } = await createRecording.execute(data);
	 *   if (error) {
	 *     notify.error.execute({ title: 'Failed to save', description: error.message });
	 *   } else {
	 *     notify.success.execute({ title: 'Recording saved!' });
	 *   }
	 * }
	 * ```
	 *
	 * @tip The imperative `.execute()` method is especially useful for:
	 * - Event handlers that need to await the result
	 * - Sequential operations that depend on each other
	 * - Non-component code that needs to trigger mutations
	 */
	const defineMutation = <TData, TError, TVariables = void, TContext = unknown>(
		options: DefineMutationInput<TData, TError, TVariables, TContext>,
	): DefineMutationOutput<TData, TError, TVariables, TContext> => {
		const newOptions = {
			...options,
			mutationFn: async (variables: TVariables) => {
				return resolve(await options.resultMutationFn(variables));
			},
		} satisfies MutationOptions<TData, TError, TVariables, TContext>;

		return {
			/**
			 * Returns the mutation options for reactive usage with TanStack Query hooks.
			 * Use this with `createMutation()` in Svelte components for reactive mutation state.
			 * @returns The mutation options object configured for TanStack Query
			 */
			options: () => newOptions,
			/**
			 * Bypasses the reactive mutation hooks and executes the mutation imperatively.
			 *
			 * This is the recommended way to trigger mutations from:
			 * - Button click handlers
			 * - Form submissions
			 * - Keyboard shortcuts
			 * - Any non-component code
			 *
			 * The method automatically wraps the result in a Result type, so you always
			 * get back `{ data, error }` for consistent error handling.
			 *
			 * @param variables - The variables to pass to the mutation function
			 * @returns Promise that resolves with a Result containing either the data or an error
			 *
			 * @example
			 * // In an event handler
			 * async function handleSubmit(formData: FormData) {
			 *   const { data, error } = await createUser.execute(formData);
			 *   if (error) {
			 *     notify.error.execute({ title: 'Failed to create user', description: error.message });
			 *     return;
			 *   }
			 *   goto(`/users/${data.id}`);
			 * }
			 */
			async execute(variables: TVariables) {
				try {
					return Ok(await executeMutation(queryClient, newOptions, variables));
				} catch (error) {
					return Err(error as TError);
				}
			},
		};
	};

	return {
		defineQuery,
		defineMutation,
	};
}

/**
 * Internal helper that executes a mutation directly using the query client's mutation cache.
 *
 * This is what powers the `.execute()` method on mutations. It bypasses the reactive
 * mutation hooks and runs the mutation imperatively, which is perfect for event handlers
 * and other imperative code.
 *
 * @internal
 * @template TData - The type of data returned by the mutation
 * @template TError - The type of error that can be thrown
 * @template TVariables - The type of variables passed to the mutation
 * @template TContext - The type of context data
 * @param queryClient - The query client instance to use
 * @param options - The mutation options including mutationFn and mutationKey
 * @param variables - The variables to pass to the mutation function
 * @returns Promise that resolves with the mutation result
 */
function executeMutation<TData, TError, TVariables, TContext>(
	queryClient: QueryClient,
	options: MutationOptions<TData, TError, TVariables, TContext>,
	variables: TVariables,
) {
	const mutation = queryClient.getMutationCache().build(queryClient, options);
	return mutation.execute(variables);
}
