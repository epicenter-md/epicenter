/**
 * A success result containing a success value and no error value
 * @template T The success type
 */
export type Ok<T> = { data: T; error: null };

/**
 * An error result containing an error value and no success value
 * @template E The error type
 */
export type Err<E> = { error: E; data: null };

/**
 * A type representing either success (Ok) or failure (Err)
 * @template T The success type
 * @template E The error type
 * @example
 * ```ts
 * const result: Result<string, Error> = Ok("success");
 * const error: Result<string, Error> = Err(new Error("failed"));
 * ```
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Creates a success result
 * @template T The success type
 * @param data The success value
 * @returns An Ok result containing the success value
 */
export const Ok = <T>(data: T): Ok<T> => ({ data, error: null });

/**
 * Creates an error result
 * @template E The error type
 * @param error The error value
 * @returns An Err result containing the error value
 */
export const Err = <E>(error: E): Err<E> => ({ error, data: null });

/**
 * Extracts the Ok type from a Result type
 * @template R The Result type to extract from
 */
export type ExtractOkFromResult<R extends Result<unknown, unknown>> = Extract<
	R,
	{ error: null }
>;

/**
 * Extracts the Err type from a Result type
 * @template R The Result type to extract from
 */
export type ExtractErrFromResult<R extends Result<unknown, unknown>> = Extract<
	R,
	{ data: null }
>;

/**
 * Extracts the success type from a Result type
 * @template R The Result type to extract from
 */
export type UnwrapOk<R extends Result<unknown, unknown>> = R extends Ok<infer U>
	? U
	: never;

/**
 * Extracts the error type from a Result type
 * @template R The Result type to extract from
 */
export type UnwrapErr<R extends Result<unknown, unknown>> = R extends Err<
	infer E
>
	? E
	: never;

/**
 * Type guard to check if a value is a valid Result type
 * @template T The success type
 * @template E The error type
 * @param value The value to check
 * @returns Type predicate indicating if the value is a Result
 */
export function isResult<T = unknown, E = unknown>(
	value: unknown,
): value is Result<T, E> {
	const isNonNullObject = typeof value === "object" && value !== null;
	if (!isNonNullObject) return false;

	const hasDataProperty = "data" in value;
	const hasErrorProperty = "error" in value;
	if (!hasDataProperty || !hasErrorProperty) return false;

	const isBothNull = value.data === null && value.error === null;
	if (isBothNull) return false;

	const isNeitherNull = value.data !== null && value.error !== null;
	if (isNeitherNull) return false;

	// Exactly one property is null
	return true;
}

/**
 * Type guard to check if a result is a success (Ok)
 * @template T The success type
 * @template E The error type
 * @param result The result to check
 * @returns Type predicate indicating if the result is Ok
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
	return result.error === null;
}

/**
 * Type guard to check if a result is an error (Err)
 * @template T The success type
 * @template E The error type
 * @param result The result to check
 * @returns Type predicate indicating if the result is Err
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
	return result.error !== null;
}

/**
 * Executes a synchronous operation and wraps the result in a Result type
 * @template T The success type
 * @template E The error type
 * @param options Object containing the operation and error mapping function
 * @param options.try The synchronous operation to execute
 * @param options.mapErr Function to map an unknown error to an Err result
 * @returns A Result containing either the success value or an error value
 */
export function trySync<T, E>({
	try: operation,
	mapErr,
}: {
	try: () => T;
	mapErr: (error: unknown) => E;
}): Result<T, E> {
	try {
		const data = operation();
		return Ok(data);
	} catch (error) {
		return Err(mapErr(error));
	}
}

/**
 * Executes an asynchronous operation and wraps the result in a Result type
 * @template T The success type
 * @template E The error type
 * @param options Object containing the operation and error mapping function
 * @param options.try The asynchronous operation to execute
 * @param options.mapErr Function to map an unknown error to an Err result
 * @returns A Promise that resolves to a Result containing either the success value or an error value
 */
export async function tryAsync<T, E>({
	try: operation,
	mapErr,
}: {
	try: () => Promise<T>;
	mapErr: (error: unknown) => E;
}): Promise<Result<T, E>> {
	try {
		const data = await operation();
		return Ok(data);
	} catch (error) {
		return Err(mapErr(error));
	}
}

/**
 * Unwraps a value that may or may not be a Result type
 *
 * If the value is a Result:
 * - Returns the data if it's an Ok result
 * - Throws the error if it's an Err result
 *
 * If the value is not a Result, returns it as-is.
 *
 * This is useful when you have a value that might be wrapped in a Result
 * and you want to either get the success value or propagate the error by throwing.
 *
 * @template T The success/value type
 * @template E The error type
 * @param value Either a plain value of type T or a Result<T, E>
 * @returns The unwrapped value of type T
 * @throws The error value if the input is an Err result
 *
 * @example
 * ```ts
 * // With a plain value
 * const plainValue = "hello";
 * const result1 = unwrapIfResult(plainValue); // Returns "hello"
 *
 * // With an Ok result
 * const okResult = Ok("success");
 * const result2 = unwrapIfResult(okResult); // Returns "success"
 *
 * // With an Err result
 * const errResult = Err(new Error("failed"));
 * const result3 = unwrapIfResult(errResult); // Throws Error("failed")
 * ```
 */
export function unwrapIfResult<T, E>(value: T | Result<T, E>): T {
	if (isResult(value)) {
		if (isOk(value)) {
			return value.data;
		}
		// If it's a Result and not Ok, it must be Err
		throw value.error;
	}

	// If it's not a Result type, return the value as-is
	return value;
}
