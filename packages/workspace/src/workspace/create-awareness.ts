/**
 * createAwareness() - Wraps a raw Awareness instance with typed helpers.
 *
 * Uses the record-of-fields pattern (same as tables and KV). Each field has its own
 * StandardSchemaV1 schema. Validation happens per-field on read (`getAll()`), not on write.
 *
 * ## API Design
 *
 * Both `setLocal()` (merge all fields) and `setLocalField()` (update one field) are provided.
 * `setLocal()` merges into current state — it does NOT replace. This matches the mental model
 * of "set these fields" and prevents accidentally losing fields.
 *
 * `setLocalField()` maps directly to y-protocols `setLocalStateField()` for single-field updates.
 *
 * ## Validation Strategy
 *
 * - **On write** (`setLocal`, `setLocalField`): Compile-time only (TypeScript).
 *   Local code, own TypeScript — runtime validation is pure overhead.
 * - **On read** (`getAll`): Per-field schema validation. Remote peers can't be trusted.
 *   Each field is independently validated; invalid fields are omitted but valid fields
 *   from the same client are still included.
 *
 * @example
 * ```typescript
 * import { Awareness } from 'y-protocols/awareness';
 * import * as Y from 'yjs';
 * import { createAwareness } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const rawAwareness = new Awareness(ydoc);
 * const awareness = createAwareness(rawAwareness, {
 *   deviceId: type('string'),
 *   deviceType: type('"browser-extension" | "desktop" | "server" | "cli"'),
 * });
 *
 * // Set all fields at once (merge)
 * awareness.setLocal({ deviceId: 'abc', deviceType: 'desktop' });
 *
 * // Update a single field
 * awareness.setLocalField('deviceType', 'server');
 *
 * // Get a single field
 * const myType = awareness.getLocalField('deviceType');
 * // ^? 'browser-extension' | 'desktop' | 'server' | 'cli' | undefined
 *
 * // Get all peers (per-field validated, invalid fields skipped)
 * const peers = awareness.getAll();
 * // ^? Map<number, { deviceId?: string; deviceType?: string }>
 * ```
 */

import type { Awareness } from 'y-protocols/awareness';
import type {
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
} from './types.js';

/**
 * Creates an AwarenessHelper by wrapping an existing Awareness instance.
 *
 * The caller owns the Awareness instance — this function only wraps it with
 * typed helpers. Each field gets its own StandardSchemaV1 schema for independent
 * validation on read.
 *
 * @param awareness - An existing y-protocols Awareness instance to wrap
 * @param definitions - Record of field name → StandardSchemaV1 schema
 * @returns AwarenessHelper with typed per-field methods
 */
export function createAwareness<TDefs extends AwarenessDefinitions>(
	awareness: Awareness,
	definitions: TDefs,
): AwarenessHelper<TDefs> {
	const defEntries = Object.entries(definitions);

	/** Validate awareness state fields against schemas. */
	function validateState(state: unknown): Record<string, unknown> {
		const validated: Record<string, unknown> = {};
		for (const [fieldKey, fieldSchema] of defEntries) {
			const fieldValue = (state as Record<string, unknown>)[fieldKey];
			if (fieldValue === undefined) continue;

			const fieldResult = fieldSchema['~standard'].validate(fieldValue);
			if (fieldResult instanceof Promise) continue;
			if (fieldResult.issues) continue;

			validated[fieldKey] = fieldResult.value;
		}
		return validated;
	}

	return {
		setLocal(state) {
			const current = awareness.getLocalState() ?? {};
			awareness.setLocalState({ ...current, ...state });
		},

		setLocalField(key, value) {
			awareness.setLocalStateField(key, value);
		},

		getLocal() {
			return awareness.getLocalState() as AwarenessState<TDefs> | null;
		},

		getLocalField(key) {
			const state = awareness.getLocalState();
			if (state === null) return undefined;
			return (state as Record<string, unknown>)[key] as ReturnType<
				AwarenessHelper<TDefs>['getLocalField']
			>;
		},

		getAll() {
			const result = new Map<number, AwarenessState<TDefs>>();
			for (const [clientId, state] of awareness.getStates()) {
				if (state === null || typeof state !== 'object') continue;
				const validated = validateState(state);
				if (Object.keys(validated).length > 0) {
					result.set(clientId, validated as AwarenessState<TDefs>);
				}
			}
			return result;
		},

		peers() {
			const result = new Map<number, AwarenessState<TDefs>>();
			const selfId = awareness.clientID;
			for (const [clientId, state] of awareness.getStates()) {
				if (clientId === selfId) continue;
				if (state === null || typeof state !== 'object') continue;
				result.set(clientId, validateState(state) as AwarenessState<TDefs>);
			}
			return result;
		},

		observe(callback) {
			const handler = ({
				added,
				updated,
				removed,
			}: {
				added: number[];
				updated: number[];
				removed: number[];
			}) => {
				const changes = new Map<number, 'added' | 'updated' | 'removed'>();
				for (const id of added) changes.set(id, 'added');
				for (const id of updated) changes.set(id, 'updated');
				for (const id of removed) changes.set(id, 'removed');
				callback(changes);
			};
			awareness.on('change', handler);
			return () => awareness.off('change', handler);
		},

		raw: awareness,
	};
}
