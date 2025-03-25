/**
 * A success result with boolean discriminant
 * @template T The type of the success data
 */
export type Ok<T> = { ok: true; data: T };

/**
 * An error result with boolean discriminant
 * @template E The type of the error
 */
export type Err<E> = { ok: false; error: E };

/**
 * A discriminated union representing either success (Ok) or failure (Err)
 * Uses a boolean 'ok' property as the discriminant
 * @template T The type of the success data
 * @template E The type of the error
 */
export type Result<T, E> = Ok<T> | Err<E>;

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
 * Creates a success result
 * @template T The type of the success data
 * @param data The success data
 * @returns An Ok result containing the data
 */
export const Ok = <T>(data: T): Ok<T> => ({ ok: true, data });

/**
 * Creates an error result
 * @template E The type of the error
 * @param error The error
 * @returns An Err result containing the error
 */
export const Err = <E>(error: E): Err<E> => ({ ok: false, error });

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
	mapErr: (error: unknown) => Err<E>;
}): Result<T, E> {
	try {
		const data = operation();
		return Ok(data);
	} catch (error) {
		return mapErr(error);
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
	mapErr: (error: unknown) => Err<E>;
}): Promise<Result<T, E>> {
	try {
		const data = await operation();
		return Ok(data);
	} catch (error) {
		return mapErr(error);
	}
}
