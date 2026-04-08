/**
 * @fileoverview Id and Guid type and generation utilities
 *
 * Provides branded Id/Guid types and nanoid-based generation functions.
 *
 * - **Id**: Table-scoped row identifiers (10 chars, safe for millions of rows)
 * - **Guid**: Globally unique workspace identifiers (15 chars, safe for millions of workspaces)
 */

import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const nanoid10 = customAlphabet(ALPHABET, 10);
const nanoid15 = customAlphabet(ALPHABET, 15);

/**
 * ID type - branded string for table row identifiers.
 *
 * 10-character alphanumeric string, safe for tables with millions of rows.
 * Only needs to be unique within a single table.
 *
 * @see {@link generateId}
 */
export type Id = string & Brand<'Id'>;

/**
 * Create a branded Id from an arbitrary string.
 *
 * Validates that the string does not contain ':' (reserved for cell-key separator).
 * Use this when you have a string ID that needs to be used as a row identifier.
 *
 * @param value - The string to brand as an Id
 * @returns A branded Id
 * @throws If the value contains ':'
 *
 * @example
 * ```typescript
 * const id = Id('my-custom-id');
 * const generated = generateId(); // Also returns Id
 * ```
 */
export function Id(value: string): Id {
	if (value.includes(':')) {
		throw new Error(`Id cannot contain ':': "${value}"`);
	}
	return value as Id;
}

/**
 * Generates a table row ID - 10 character alphanumeric string.
 *
 * Safe for tables with up to ~85 million rows (1-in-a-million collision chance).
 * Only needs to be unique within a single table, not globally.
 *
 * @returns Unique identifier as branded string
 * @example
 * ```typescript
 * const id = generateId(); // "k7x9m2p4q8"
 * ```
 */
export function generateId(): Id {
	return nanoid10() as Id;
}

/**
 * GUID type - branded string for globally unique workspace identifiers.
 *
 * 15-character alphanumeric string, safe for millions of workspaces globally.
 * Used for YJS document coordination and sync.
 *
 * @see {@link generateGuid}
 */
export type Guid = string & Brand<'Guid'>;

/**
 * Generates a globally unique workspace identifier - 15 character alphanumeric string.
 *
 * Safe for up to ~700 million workspaces globally (1-in-a-billion collision chance).
 * Used for YJS document coordination, websocket rooms, and sync identity.
 *
 * @returns Globally unique identifier as branded string
 * @example
 * ```typescript
 * const guid = generateGuid(); // "abc123xyz789012"
 * ```
 */
export function generateGuid(): Guid {
	return nanoid15() as Guid;
}
