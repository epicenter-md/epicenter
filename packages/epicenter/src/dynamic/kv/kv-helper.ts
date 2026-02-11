import { type ArkErrors, type } from 'arktype';
import { createTaggedError } from 'wellcrafted/error';
import type * as Y from 'yjs';
import type {
	YKeyValueLww,
	YKeyValueLwwChange,
} from '../../shared/y-keyvalue/y-keyvalue-lww';
import type { KvField, KvValue } from '../schema';
import { fieldToYjsArktype, isNullableField } from '../schema';

/**
 * Change event for a KV value.
 *
 * Matches the same semantics as the old YKeyValue change events:
 * - `add`: Key was set for the first time
 * - `update`: Key's value was changed
 * - `delete`: Key was removed
 */
export type KvChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; oldValue: T; newValue: T }
	| { action: 'delete'; oldValue: T };

type KvValidationContext = {
	key: string;
	errors: ArkErrors;
	summary: string;
};

const { KvValidationError } =
	createTaggedError('KvValidationError').withContext<KvValidationContext>();

type KvValidationError = ReturnType<typeof KvValidationError>;

/**
 * Result of getting a KV value.
 * Uses a status-based discriminated union for explicit handling of all cases.
 */
export type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| { status: 'invalid'; key: string; error: KvValidationError }
	| { status: 'not_found'; key: string };

export function createKvHelper<TField extends KvField>({
	ykvLww,
	field,
}: {
	ykvLww: YKeyValueLww<KvValue>;
	field: TField;
}) {
	type TValue = KvValue<TField>;

	const keyName = field.id;
	const nullable = isNullableField(field);
	const validator = fieldToYjsArktype(field);

	return {
		/**
		 * Get the current value for this KV key.
		 *
		 * Returns a discriminated union with status:
		 * - `{ status: 'valid', value }` if value exists and passes validation
		 * - `{ status: 'invalid', key, error }` if value exists but fails validation
		 * - `{ status: 'not_found', key }` if value is unset (no default, not nullable)
		 *
		 * For unset values: returns default if defined, null if nullable.
		 *
		 * @example
		 * ```typescript
		 * const result = kv.get('theme');
		 * if (result.status === 'valid') {
		 *   console.log(result.value); // 'dark' | 'light'
		 * } else if (result.status === 'invalid') {
		 *   console.error(result.error.context.summary);
		 * } else {
		 *   console.log('Key not set:', result.key);
		 * }
		 * ```
		 */
		get(): KvGetResult<TValue> {
			const rawValue = ykvLww.get(keyName);

			// Handle undefined: default → null → not_found
			if (rawValue === undefined) {
				if ('default' in field && field.default !== undefined) {
					return { status: 'valid', value: field.default as TValue };
				}
				if (nullable) {
					return { status: 'valid', value: null as TValue };
				}
				return { status: 'not_found', key: keyName };
			}

			// Validate existing value
			const validationResult = validator(rawValue);
			if (validationResult instanceof type.errors) {
				return {
					status: 'invalid',
					key: keyName,
					error: KvValidationError({
						message: `KV key '${keyName}' failed validation`,
						context: {
							key: keyName,
							errors: validationResult,
							summary: validationResult.summary,
						},
					}),
				};
			}

			return { status: 'valid', value: rawValue as TValue };
		},

		/**
		 * Set the value for this KV key.
		 *
		 * All field types (text, select, boolean, integer, real, date, richtext, tags)
		 * accept plain JavaScript values. The value is stored directly in YJS.
		 *
		 * @param value - The value to set
		 *
		 * @example
		 * ```typescript
		 * kv.set('theme', 'dark');
		 * kv.set('count', 42);
		 * kv.set('categories', ['tech', 'blog']);
		 * ```
		 */
		set(value: TValue): void {
			ykvLww.set(keyName, value as KvValue);
		},

		/**
		 * Watch for changes to this KV value.
		 *
		 * Callback receives the raw change from YJS with:
		 * - `action`: 'add' | 'update' | 'delete'
		 * - `newValue`: the new value (for add/update)
		 * - `oldValue`: the previous value (for update/delete)
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = kv.observeKey('theme', (change, transaction) => {
		 *   switch (change.action) {
		 *     case 'add':
		 *     case 'update':
		 *       document.body.className = String(change.newValue);
		 *       break;
		 *     case 'delete':
		 *       document.body.className = '';
		 *       break;
		 *   }
		 * });
		 * unsubscribe(); // Stop watching
		 * ```
		 */
		observe(
			callback: (change: KvChange<TValue>, transaction: Y.Transaction) => void,
		): () => void {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<KvValue>>,
				transaction: Y.Transaction,
			) => {
				const keyChange = changes.get(keyName);
				if (!keyChange) return;

				// Map YKeyValueLwwChange to KvChange (they're the same structure)
				callback(keyChange as KvChange<TValue>, transaction);
			};

			ykvLww.observe(handler);
			return () => ykvLww.unobserve(handler);
		},

		/**
		 * Reset this KV key to its default value.
		 *
		 * If a default is defined in the schema, sets to that value.
		 * If nullable with no default, sets to null.
		 * Otherwise, deletes the key entirely (subsequent `get()` returns `not_found`).
		 *
		 * @example
		 * ```typescript
		 * kv.reset('theme'); // Back to schema default
		 * ```
		 */
		reset(): void {
			if ('default' in field && field.default !== undefined) {
				this.set(field.default as TValue);
			} else if (nullable) {
				this.set(null as TValue);
			} else {
				ykvLww.delete(keyName);
			}
		},

		/**
		 * Type inference helper for the runtime value type.
		 *
		 * @example
		 * ```typescript
		 * type Theme = typeof kv.definitions.theme.field extends SelectField<infer O> ? O[number] : never;
		 * // Or use the schema directly for type inference
		 * ```
		 */
		inferValue: null as unknown as TValue,
	};
}

export type KvHelper<TField extends KvField> = ReturnType<
	typeof createKvHelper<TField>
>;
