import type { StandardSchemaV1 } from '@standard-schema/spec';
import { on } from 'svelte/events';
import { createSubscriber } from 'svelte/reactivity';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { trySync } from 'wellcrafted/result';

type ParseErrorReason<TSchema extends StandardSchemaV1> =
	| { type: 'storage_empty'; key: string }
	| { type: 'json_parse_error'; key: string; rawValue: string; error: unknown }
	| {
			type: 'schema_validation_async_during_sync';
			key: string;
			value: unknown;
			schema: TSchema;
	  }
	| {
			type: 'schema_validation_failed';
			key: string;
			value: unknown;
			schema: TSchema;
			issues: ReadonlyArray<StandardSchemaV1.Issue>;
	  };

/**
 * Creates a persisted state object tied to local storage, accessible through `.value`
 *
 * Features:
 * - Synchronous initialization with immediate access to a valid value
 * - Automatic validation using the provided schema
 * - Cross-tab synchronization via storage events
 * - Graceful error recovery via onParseError handler
 * - Type-safe getter and setter
 *
 * @example
 * ```ts
 * const settings = createPersistedState({
 *   key: 'app-settings',
 *   schema: settingsSchema,
 *   onParseError: (error) => {
 *     console.error('Settings parse error:', error);
 *     return { theme: 'light', notifications: true }; // return default
 *   }
 * });
 *
 * // Use in component
 * $effect(() => {
 *   console.log('Current settings:', settings.value);
 * });
 *
 * // Update settings
 * settings.value = { theme: 'dark', notifications: false };
 * ```
 */
export function createPersistedState<TSchema extends StandardSchemaV1>({
	key,
	schema,
	onParseError,
	onUpdateSuccess,
	onUpdateError,
	onUpdateSettled,
}: {
	/** The key used to store the value in local storage. */
	key: string;
	/**
	 * The schema used to validate the value from local storage.
	 * */
	schema: TSchema;
	/**
	 * Handler called when the value from storage cannot be parsed or validated.
	 * This function can perform side effects and must return a valid value.
	 *
	 * @param error - A discriminated union describing what went wrong:
	 *   - `storage_empty`: No value found in storage
	 *   - `json_parse_error`: Failed to parse JSON from storage
	 *   - `schema_validation_async_during_sync`: Schema returned a Promise during synchronous parsing
	 *   - `schema_validation_failed`: Schema validation failed with issues
	 *
	 * @returns A valid value that satisfies the schema
	 *
	 * @example
	 * ```ts
	 * onParseError: (error) => {
	 *   if (error.type === 'storage_empty') {
	 *     return { theme: 'light' }; // default value
	 *   }
	 *   console.error('Parse error:', error);
	 *   return { theme: 'light' }; // fallback value
	 * }
	 * ```
	 */
	onParseError: (
		error: ParseErrorReason<TSchema>,
	) => StandardSchemaV1.InferOutput<TSchema>;
	/**
	 * Handler for when the value from storage is successfully updated.
	 */
	onUpdateSuccess?: (newValue: StandardSchemaV1.InferOutput<TSchema>) => void;
	/**
	 * Handler for when the value from storage fails to update.
	 */
	onUpdateError?: (error: unknown) => void;
	/**
	 * Handler for when the value from storage update is settled.
	 */
	onUpdateSettled?: () => void;
}) {
	const parseValueFromStorage = (
		rawValue: string | null,
	): StandardSchemaV1.InferOutput<TSchema> => {
		if (rawValue === null) return onParseError({ type: 'storage_empty', key });

		const { data: parsedValue, error: parseError } = parseJson(rawValue);
		if (parseError) {
			return onParseError({
				type: 'json_parse_error',
				key,
				rawValue,
				error: parseError,
			});
		}

		const result = schema['~standard'].validate(parsedValue);
		if (result instanceof Promise) {
			return onParseError({
				type: 'schema_validation_async_during_sync',
				key,
				value: parsedValue,
				schema,
			});
		}

		if (result.issues) {
			return onParseError({
				type: 'schema_validation_failed',
				key,
				value: parsedValue,
				schema,
				issues: result.issues,
			});
		}

		return result.value as StandardSchemaV1.InferOutput<TSchema>;
	};

	let value = $state(parseValueFromStorage(window.localStorage.getItem(key)));

	const subscribe = createSubscriber((update) => {
		const storage = on(window, 'storage', (e) => {
			if (e.key !== key) return;
			value = parseValueFromStorage(e.newValue);
			update(); // Notify reactive contexts of state change
		});

		const focus = on(window, 'focus', () => {
			value = parseValueFromStorage(window.localStorage.getItem(key));
			update(); // Notify reactive contexts of state change
		});

		return () => {
			storage();
			focus();
		};
	});

	// No need for initial load in $effect since value is set synchronously above

	return {
		get value() {
			subscribe();
			return value;
		},
		set value(newValue: StandardSchemaV1.InferOutput<TSchema>) {
			value = newValue;
			try {
				window.localStorage.setItem(key, JSON.stringify(newValue));
				onUpdateSuccess?.(newValue);
			} catch (error) {
				onUpdateError?.(error);
			} finally {
				onUpdateSettled?.();
			}
		},
	};
}

const { ParseJsonErr } = createTaggedError<'ParseJsonError', { value: string }>(
	'ParseJsonError',
);

function parseJson(value: string) {
	return trySync({
		try: () => JSON.parse(value) as unknown,
		catch: (e) =>
			ParseJsonErr({
				message: `Failed to parse JSON: ${extractErrorMessage(e)}`,
				context: { value },
			}),
	});
}
