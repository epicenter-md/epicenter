/**
 * Compute a fractional index between two bounds.
 * Adds small jitter to prevent collisions on concurrent reorders.
 *
 * @param start - Lower bound (exclusive)
 * @param end - Upper bound (exclusive)
 * @returns A number strictly between start and end
 */
export function computeMidpoint(start: number, end: number): number {
	const mid = (start + end) / 2;
	const range = (end - start) * 1e-10;
	const jitter = -range / 2 + Math.random() * range;
	return mid + jitter;
}

/**
 * Generate evenly-spaced initial order values for n items.
 * Values are between 0 (exclusive) and 1 (exclusive).
 *
 * @example
 * ```typescript
 * generateInitialOrders(3) // [0.25, 0.5, 0.75]
 * ```
 */
export function generateInitialOrders(count: number): number[] {
	return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1));
}
