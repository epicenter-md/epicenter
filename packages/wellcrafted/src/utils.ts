import type { Err, Ok, Result } from "./result.js";
import { isOk } from "./result.js";

/**
 * Partitions an array of Result objects into two separate arrays based on their status.
 *
 * @template T - The success type
 * @template E - The error type
 * @param results - An array of Result objects to partition
 * @returns An object containing two arrays:
 *   - `oks`: Array of successful Result objects (Ok<T>[])
 *   - `errs`: Array of error Result objects (Err<E>[])
 *
 * @example
 * const results = [Ok(1), Err("error"), Ok(2)];
 * const { oks, errs } = partitionResults(results);
 * // oks = [Ok(1), Ok(2)]
 * // errs = [Err("error")]
 */
export function partitionResults<T, E>(results: Result<T, E>[]) {
	return {
		oks: [],
		errs: [],
		...Object.groupBy(results, (result) => (isOk(result) ? "oks" : "errs")),
	} as { oks: Ok<T>[]; errs: Err<E>[] };
}
