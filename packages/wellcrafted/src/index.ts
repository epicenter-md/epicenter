/**
 * Result pattern implementation with different variants
 *
 * This module provides two different implementations of the Result pattern:
 *
 * 1. Discriminated: Uses a boolean flag (`ok: true|false`) as the discriminant
 * 2. Exclusive: Uses null values for absence (`error: null` or `data: null`)
 *
 * Choose the implementation that best fits your coding style and project needs.
 */

/**
 * Re-exports from the discriminated union implementation (boolean flag)
 */
export * as discriminated from "./discriminated";

/**
 * Re-exports from the exclusive implementation (null values)
 */
export * as exclusive from "./exclusive";

/**
 * Default export is the discriminated implementation,
 * which is the more common approach with TypeScript discriminated unions
 */
export * from "./discriminated";
