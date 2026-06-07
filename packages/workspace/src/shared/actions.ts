/**
 * Actions: typed queries (reads) and mutations (writes) authored as a flat
 * record keyed by snake_case key. `defineQuery`/`defineMutation` attach metadata
 * to the handler and return it. The action callable IS the handler, so local
 * callers see exactly what the author wrote (sync stays sync, `Result` stays
 * `Result`).
 *
 * One shape, two views:
 *
 *     ActionRegistry                       ActionManifest
 *     flat, callable                       flat, metadata-only
 *     local, in-memory                     wire form
 *
 *     {                                    {
 *       tabs_close:   Action,                tabs_close:   { type, ... },
 *       'ping':       Action,                'ping':       { type, ... },
 *     }                                    }
 *
 * Functions don't serialize, so the wire form drops them and keeps just the
 * metadata. The wire form is "the registry minus handlers"; both views index
 * by the same snake_case key. There is no walker, no segment loop, no path
 * resolver: `Object.entries(actions)` is the iterator, `actions[key]` is
 * the lookup.
 *
 * Local callers use `invokeAction`, which Ok-wraps raw values, preserves
 * existing Results, and catches throws as `Err(cause)`. The dispatch wire
 * boundary (`runInboundDispatch` in `document/dispatch.ts`) calls `invokeAction`
 * and wraps its error into `DispatchError.ActionFailed` before the response
 * crosses the wire.
 *
 * @module
 */

import Type, { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, isResult, Ok, type Result } from 'wellcrafted/result';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * `any` distributes over both branches giving `[input: any] | []`, which
 * correctly allows calling with 0 arguments for no-input actions when the type
 * flows through `Action` with wildcard parameters.
 *
 * Parameterized on `R` (the handler's actual return type) rather than splitting
 * `TOutput`/`TError`: keeps the action's callable signature exactly equal to
 * the handler's, so passthrough preserves precision (no widening to a
 * `T | Result<T, E> | Promise<...>` union).
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = (...args: TInput extends TSchema ? [input: Static<TInput>] : []) => R;

/**
 * Configuration for defining an action (query or mutation).
 */
type ActionConfig<TInput extends TSchema | undefined, R> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Optional; the action key is used when omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, R>;
};

type ActionType = 'query' | 'mutation';

/**
 * Metadata properties attached to a callable action.
 *
 * `input` (a live `TSchema`) is present whenever the action defines one.
 * Action discovery returns this shape directly. There is no separate
 * wire form.
 */
export type ActionMeta<
	TInput extends TSchema | undefined = TSchema | undefined,
	TType extends ActionType = ActionType,
> = {
	type: TType;
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Optional; the action key is used when omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * Wire schema for {@link ActionMeta}. Defines the single source of truth for
 * the metadata-only projection that crosses the wire (presence frame device
 * manifests, daemon `/list` route, etc.). The `input` field is `Type.Object()`
 * with additional properties allowed because the device's local input schema
 * is itself a TypeBox/JSON Schema object; the wire validator only confirms
 * shape, not the inner schema's semantics.
 *
 * `Static<typeof ActionMetaSchema>` collapses the parameterized in-process
 * {@link ActionMeta} to its wire form (`input?: object`), which is the shape
 * the receiver actually sees over the WebSocket.
 */
export const ActionMetaSchema = Type.Object({
	type: Type.Enum(['query', 'mutation']),
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	input: Type.Optional(
		Type.Object({}, { additionalProperties: Type.Unknown() }),
	),
});

/**
 * Flat snake_case key to `ActionMeta` map. The metadata-only projection of an
 * `ActionRegistry`, suitable for surfaces that cannot carry callable handlers
 * (e.g. the daemon `/list` route).
 */
export type ActionManifest = Record<string, ActionMeta>;

/**
 * A query or mutation action definition. Callable function with metadata
 * properties attached. Queries are idempotent reads; mutations write. The
 * `type` discriminant lives on the value, so the type stays a single union
 * rather than three named aliases. The local callable shape IS the handler's
 * signature (sync stays sync, raw stays raw); the RPC boundary normalizes
 * the response to `Result<T, DispatchError>` before it crosses the wire.
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
	TType extends ActionType = ActionType,
> = ActionHandler<TInput, R> & ActionMeta<TInput, TType>;

/**
 * Flat snake_case key to `Action` map. The single shape for an in-process
 * action surface: keys are the local address, peer RPC method, daemon
 * argument, CLI flag, and AI tool name. Author with `defineActions({...})`
 * so the helper enforces the key shape at compile time and at construction;
 * consumers iterate with `Object.entries` or index by string.
 */
export type ActionRegistry = Record<string, Action>;

// ════════════════════════════════════════════════════════════════════════════
// KEY VALIDATION (compile-time + runtime)
// ════════════════════════════════════════════════════════════════════════════

type Lower =
	| 'a'
	| 'b'
	| 'c'
	| 'd'
	| 'e'
	| 'f'
	| 'g'
	| 'h'
	| 'i'
	| 'j'
	| 'k'
	| 'l'
	| 'm'
	| 'n'
	| 'o'
	| 'p'
	| 'q'
	| 'r'
	| 's'
	| 't'
	| 'u'
	| 'v'
	| 'w'
	| 'x'
	| 'y'
	| 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type WordChar = Lower | Digit | '_';

/** Recursive tail check: every remaining char must be `[a-z0-9_]`. */
type IsActionKeyTail<S extends string> = S extends ''
	? true
	: S extends `${WordChar}${infer Rest}`
		? IsActionKeyTail<Rest>
		: false;

/**
 * `true` iff `S` matches `^[a-z][a-z0-9_]*$` at the type level. Length is
 * not checked here; the regex catches >64 at runtime. Verified empirically:
 * `arkregex` falls back to `string` for `[a-z]`-class patterns, so we
 * hand-write the template literal walk.
 */
type IsSnakeCaseKey<S extends string> = S extends `${Lower}${infer Rest}`
	? IsActionKeyTail<Rest> extends true
		? true
		: false
	: false;

/**
 * Branded type-level error returned from `ValidatedKey<S>` when `S` is not
 * a valid snake_case action key.
 *
 * The trailing `​` (Unicode zero-width space) makes this literal
 * structurally distinct from any plain string a user could type. TypeScript
 * renders the message in IDE error tooltips without showing the invisible
 * character, so the developer sees a clean English sentence:
 *
 *     Type 'Action' is not assignable to type
 *     'Invalid action key "tabs.close", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/'.
 *
 * Same pattern `@ark/util`'s internal `ErrorMessage<M>` uses. Inlined here
 * because that helper is not part of `arktype`'s public surface.
 */
type InvalidActionKey<S extends string> =
	`Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;

/**
 * Regex enforcing `^[a-z][a-z0-9_]{0,63}$` at runtime. Used by
 * `defineActions` for the authoring boundary check and by
 * `openCollaboration` for the construction-time defense against `as`
 * casts. Exported so tests and future external validators can share the
 * single source of truth.
 */
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Author an `ActionRegistry` with compile-time + runtime key validation.
 *
 * Compile time: each key is checked against the snake_case template-literal
 * type `IsSnakeCaseKey<K>`. A bad key (`'tabs.close'`, `'TabsClose'`,
 * `'0tab'`, `'_x'`) gets typed to `InvalidActionKey<K>` (a branded error
 * string) at that property, so the `Action` value the author wrote fails
 * to assign and TypeScript surfaces the error message at the edit site.
 *
 * Runtime: each key is checked against `ACTION_KEY_PATTERN` so dynamic
 * builders (`Object.fromEntries(...)`) and `as ActionRegistry` casts that
 * bypass the type still fail fast at construction.
 *
 * @example
 * ```ts
 * const actions = defineActions({
 *   entries_create: defineMutation({ ... }),
 *   entries_update: defineMutation({ ... }),
 * });
 * ```
 */
export function defineActions<T extends ActionRegistry>(
	actions: {
		[K in keyof T & string]: IsSnakeCaseKey<K> extends true
			? T[K]
			: InvalidActionKey<K>;
	},
): T {
	for (const key of Object.keys(actions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}
	return actions as T;
}

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns (sync if sync,
 * raw if raw, `Result` if explicit). Remote callers go through
 * `collab.dispatch`, which normalizes the response to
 * `Result<T, DispatchError>` before it crosses the wire.
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineQuery<R>(
	config: ActionConfig<undefined, R>,
): Action<undefined, R, 'query'>;
/** With input. `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Action<TInput, R, 'query'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineQuery({ handler, ...rest }: any): Action {
	return Object.assign(handler, { type: 'query' as const, ...rest });
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns; remote/AI/CLI
 * consumers see uniform `Promise<Result>` via the boundary normalizers.
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineMutation<R>(
	config: ActionConfig<undefined, R>,
): Action<undefined, R, 'mutation'>;
/** With input. `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Action<TInput, R, 'mutation'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineMutation({ handler, ...rest }: any): Action {
	return Object.assign(handler, { type: 'mutation' as const, ...rest });
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Structural check: anything callable with a `type` of `'query'` or
 * `'mutation'` is an action.
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
 */
export function isQuery(
	value: unknown,
): value is Action<TSchema | undefined, unknown, 'query'> {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 */
export function isMutation(
	value: unknown,
): value is Action<TSchema | undefined, unknown, 'mutation'> {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Project a callable action onto its wire-form metadata. Functions drop;
 * live schemas, titles, and descriptions are kept. Used at the daemon
 * `/list` route and any other surface that needs metadata without handlers.
 */
export function toActionMeta({
	type,
	input,
	title,
	description,
}: Action): ActionMeta {
	const meta: ActionMeta = { type };
	if (input !== undefined) meta.input = input;
	if (title !== undefined) meta.title = title;
	if (description !== undefined) meta.description = description;
	return meta;
}

/**
 * Raised by {@link invokeAction} when the supplied input fails the action's
 * declared `input` schema. This is the one place the schema is enforced at
 * runtime: a value that reaches a handler has already matched the contract the
 * action published. The daemon maps it to a usage error (bad input, not a
 * handler crash); the dispatch boundary folds it into `ActionFailed`.
 */
export const ActionInputError = defineErrors({
	InvalidInput: ({
		errors,
	}: {
		errors: { path: string; message: string }[];
	}) => ({
		message: `Invalid action input: ${errors
			.map((e) => `${e.path || '(root)'} ${e.message}`)
			.join('; ')}`,
		errors,
	}),
});
export type ActionInputError = InferErrors<typeof ActionInputError>;

/**
 * Narrows an `invokeAction` error to a declared-schema validation failure.
 *
 * The error channel of `invokeAction` is `unknown` (a handler can throw
 * anything), so a boundary that special-cases the validation failure needs a
 * type guard to reach `.message` safely. This is the sanctioned single-variant
 * guard, not a total fold: callers special-case `InvalidInput`, every other
 * error flows through unchanged.
 */
export function isActionInputError(error: unknown): error is ActionInputError {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'InvalidInput'
	);
}

/**
 * Invoke an action when the caller does not statically know the handler
 * return shape.
 *
 * When the action declares an `input` schema, the supplied input is validated
 * against it first; a mismatch returns `Err(ActionInputError.InvalidInput)`
 * without ever calling the handler, so the published schema is load-bearing at
 * the trust boundary rather than discovery-only metadata.
 *
 * Otherwise: raw values get `Ok`-wrapped, existing `Result`s pass through, and
 * thrown errors become `Err(cause)` with the raw thrown value under `.error`.
 * The dispatch wire boundary (`runInboundDispatch` in `document/dispatch.ts`)
 * is responsible for wrapping the cause into `DispatchError.ActionFailed`
 * before the response crosses the wire; callers in-process see whatever
 * the handler actually threw or returned.
 *
 * @example
 * ```ts
 * const result = await invokeAction<{ closedCount: number }>(
 *   workspace.actions.tabs_close,
 *   { tabIds: [1, 2] },
 * );
 * if (result.error) { ... }
 * console.log(result.data.closedCount);
 * ```
 */
export async function invokeAction<T = unknown>(
	action: Action,
	input: unknown | undefined,
): Promise<Result<T, unknown>> {
	if (action.input !== undefined && !Value.Check(action.input, input)) {
		const errors = [...Value.Errors(action.input, input)].map((e) => ({
			path: e.instancePath.replace(/^\//, ''),
			message: e.message,
		}));
		return ActionInputError.InvalidInput({ errors });
	}
	try {
		const ret =
			action.input !== undefined
				? await (action as (i: unknown) => unknown)(input)
				: await (action as () => unknown)();
		return (isResult(ret) ? ret : Ok(ret)) as Result<T, unknown>;
	} catch (cause) {
		return Err(cause);
	}
}
