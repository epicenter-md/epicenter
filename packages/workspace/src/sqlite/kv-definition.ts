/**
 * The release-local KV lens (ADR-0130/0132).
 *
 * Canonical KV is one bounded schema-blind JSON map stored at the reserved
 * record address. The `kv` object in a workspace definition is this release's
 * typed lens over that map: it declares known keys and validates present
 * values. Every key is structurally optional; reads never materialize
 * defaults, repair invalid values, or migrate stored data; unknown and
 * nonconforming values survive every path.
 */
import { compile, recognize } from '@epicenter/field';
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { JsonValue } from './lens-definition.js';

export type KvDefinitions = Readonly<Record<string, TSchema>>;

/**
 * `Static` mapped once over the whole lens. Computing `Static` inline per
 * method call exceeds TypeScript's instantiation depth against real lenses
 * (Whispering's 39 entries include a ~120-literal select), so every typed
 * surface indexes into this precomputed map instead.
 */
export type KvValues<TDefinitions extends KvDefinitions> = {
	[K in keyof TDefinitions]: Static<TDefinitions[K]>;
};

export const KvReadError = defineErrors({
	NonconformingKvValue: ({ key, raw }: { key: string; raw: JsonValue }) => ({
		message: `Stored KV value for '${key}' does not satisfy the current lens`,
		key,
		raw,
	}),
});
export type KvReadError = InferErrors<typeof KvReadError>;

export const KvWriteError = defineErrors({
	InvalidKvWrite: ({ key, reason }: { key: string; reason: string }) => ({
		message: `KV write for '${key}' was refused: ${reason}`,
		key,
		reason,
	}),
});
export type KvWriteError = InferErrors<typeof KvWriteError>;

export type CompiledKvLens = ReadonlyMap<
	string,
	{ key: string; check(value: unknown): boolean }
>;

/**
 * Compile one release's KV lens. Keys are permanent storage keys: bounded,
 * never reserved-prefixed. Values use the `field.*` vocabulary so present
 * values validate identically everywhere the lens travels.
 */
export function compileKvLens(definitions: KvDefinitions): CompiledKvLens {
	const compiled = new Map<string, { key: string; check(value: unknown): boolean }>();
	for (const [key, schema] of Object.entries(definitions)) {
		assertKvKey(key);
		const recognized = recognize(JSON.parse(JSON.stringify(schema)));
		if (!recognized) {
			throw new Error(`KV key '${key}' must use the field.* vocabulary`);
		}
		const check = compile(recognized.schema);
		compiled.set(key, { key, check });
	}
	return compiled;
}

function assertKvKey(key: string): void {
	if (
		key.length === 0 ||
		key.length > 256 ||
		key.startsWith('__epicenter_') ||
		key.trim() !== key
	) {
		throw new Error(
			`Invalid KV key '${key}'; use a short stable name without the internal prefix`,
		);
	}
}
