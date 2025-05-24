/**
 * A success result containing data and no error
 * @template T The type of the success data
 */
export type Ok<T> = { data: T; error: null };

/**
 * An error result containing an error and no data
 * @template E The type of the error
 */
export type Err<E> = { error: E; data: null };

/**
 * A discriminated union representing either success (Ok) or failure (Err)
 * @template T The type of the success data
 * @template E The type of the error
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Creates a success result
 * @template T The type of the success data
 * @param data The success data
 * @returns An Ok result containing the data
 */
export const Ok = <T>(data: T): Ok<T> => ({ data, error: null });

/**
 * Creates an error result
 * @template E The type of the error
 * @param error The error
 * @returns An Err result containing the error
 */
export const Err = <E>(error: E): Err<E> => ({ error, data: null });

/**
 * Extracts the success type from a Result type
 * @template R Result type to extract from
 */
export type InferOk<R extends Result<unknown, unknown>> = R extends Ok<infer U>
	? U
	: never;

/**
 * Extracts the error type from a Result type
 * @template R Result type to extract from
 */
export type InferErr<R extends Result<unknown, unknown>> = R extends Err<
	infer E
>
	? E
	: never;

/**
 * Type guard to check if a result is a success (Ok)
 * @template T The type of the success data
 * @template E The type of the error
 * @param result The result to check
 * @returns Type predicate indicating if the result is Ok
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
	return result.error === null;
}

/**
 * Type guard to check if a result is an error (Err)
 * @template T The type of the success data
 * @template E The type of the error
 * @param result The result to check
 * @returns Type predicate indicating if the result is Err
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
	return result.error !== null;
}

/**
 * Executes a synchronous operation and wraps the result in a Result type
 * @template T The type of the success data
 * @template E The type of the error
 * @param options Object containing the operation and error mapping function
 * @param options.try The synchronous operation to execute
 * @param options.mapErr Function to map an unknown error to an Err result
 * @returns A Result containing either the successful data or an error
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
 * @template T The type of the success data
 * @template E The type of the error
 * @param options Object containing the operation and error mapping function
 * @param options.try The asynchronous operation to execute
 * @param options.mapErr Function to map an unknown error to an Err result
 * @returns A Promise that resolves to a Result containing either the successful data or an error
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
