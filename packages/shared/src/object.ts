/**
 * Safely looks up a value in an object by key.
 * Returns undefined if the key doesn't exist, avoiding type assertions.
 *
 * @param obj - The object to look up in
 * @param key - The key to look up
 * @returns The value at the key, or undefined if the key doesn't exist
 *
 * @example
 * const aliases = { 'audio/wave': 'audio/wav' } as const;
 * const result = safeLookup(aliases, someKey); // string | undefined
 */
export function safeLookup<T extends Record<string, unknown>>(
	obj: T,
	key: string,
): T[keyof T] | undefined {
	return key in obj ? obj[key as keyof T] : undefined;
}
