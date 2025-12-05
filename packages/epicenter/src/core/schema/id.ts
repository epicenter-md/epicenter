/**
 * @fileoverview Id type and generation utilities
 *
 * Provides branded Id type and nanoid-based generation function.
 */

import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

/**
 * ID type - branded string
 * @see {@link generateId}
 */
export type Id = string & Brand<'Id'>;

/**
 * Generates a nano ID - 15 character alphanumeric string
 *
 * @returns Unique identifier as branded string
 * @example
 * ```typescript
 * const id = generateId(); // "abc123xyz789def"
 * ```
 */
export function generateId(): Id {
	const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);
	return nanoid() as Id;
}
