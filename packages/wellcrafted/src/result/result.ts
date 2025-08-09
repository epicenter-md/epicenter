/**
 * Represents the successful outcome of an operation, encapsulating the success value.
 *
 * This is the 'Ok' variant of the `Result` type. It holds a `data` property
 * of type `T` (the success value) and an `error` property explicitly set to `null`,
 * signifying no error occurred.
 *
 * Use this type in conjunction with `Err<E>` and `Result<T, E>`.
 *
 * @template T - The type of the success value contained within.
 */
export type Ok<T> = { data: T; error: null };

/**
 * Represents the failure outcome of an operation, encapsulating the error value.
 *
 * This is the 'Err' variant of the `Result` type. It holds an `error` property
 * of type `E` (the error value) and a `data` property explicitly set to `null`,
 * signifying that no success value is present due to the failure.
 *
 * Use this type in conjunction with `Ok<T>` and `Result<T, E>`.
 *
 * @template E - The type of the error value contained within.
 */
export type Err<E> = { error: E; data: null };

/**
 * A type that represents the outcome of an operation that can either succeed or fail.
 *
 * `Result<T, E>` is a discriminated union type with two possible variants:
 * - `Ok<T>`: Represents a successful outcome, containing a `data` field with the success value of type `T`.
 *            In this case, the `error` field is `null`.
 * - `Err<E>`: Represents a failure outcome, containing an `error` field with the error value of type `E`.
 *            In this case, the `data` field is `null`.
 *
 * This type promotes explicit error handling by requiring developers to check
 * the variant of the `Result` before accessing its potential value or error.
 * It helps avoid runtime errors often associated with implicit error handling (e.g., relying on `try-catch` for all errors).
 *
 * @template T - The type of the success value if the operation is successful (held in `Ok<T>`).
 * @template E - The type of the error value if the operation fails (held in `Err<E>`).
 * @example
 * ```ts
 * function divide(numerator: number, denominator: number): Result<number, string> {
 *   if (denominator === 0) {
 *     return Err("Cannot divide by zero");
 *   }
 *   return Ok(numerator / denominator);
 * }
 *
 * const result1 = divide(10, 2);
 * if (isOk(result1)) {
 *   console.log("Success:", result1.data); // Output: Success: 5
 * }
 *
 * const result2 = divide(10, 0);
 * if (isErr(result2)) {
 *   console.error("Failure:", result2.error); // Output: Failure: Cannot divide by zero
 * }
 * ```
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Constructs an `Ok<T>` variant, representing a successful outcome.
 *
 * This factory function creates the success variant of a `Result`.
 * It wraps the provided `data` (the success value) and ensures the `error` property is `null`.
 *
 * @template T - The type of the success value.
 * @param data - The success value to be wrapped in the `Ok` variant.
 * @returns An `Ok<T>` object with the provided data and `error` set to `null`.
 * @example
 * ```ts
 * const successfulResult = Ok("Operation completed successfully");
 * // successfulResult is { data: "Operation completed successfully", error: null }
 * ```
 */
export const Ok = <T>(data: T): Ok<T> => ({ data, error: null });

/**
 * Constructs an `Err<E>` variant, representing a failure outcome.
 *
 * This factory function creates the error variant of a `Result`.
 * It wraps the provided `error` (the error value) and ensures the `data` property is `null`.
 *
 * @template E - The type of the error value.
 * @param error - The error value to be wrapped in the `Err` variant. This value represents the specific error that occurred.
 * @returns An `Err<E>` object with the provided error and `data` set to `null`.
 * @example
 * ```ts
 * const failedResult = Err(new TypeError("Invalid input"));
 * // failedResult is { error: TypeError("Invalid input"), data: null }
 * ```
 */
export const Err = <E>(error: E): Err<E> => ({ error, data: null });

/**
 * Utility type to extract the `Ok<T>` variant from a `Result<T, E>` union type.
 *
 * If `R` is a `Result` type (e.g., `Result<string, Error>`), this type will resolve
 * to `Ok<string>`. This can be useful in generic contexts or for type narrowing.
 *
 * @template R - The `Result<T, E>` union type from which to extract the `Ok<T>` variant.
 *             Must extend `Result<unknown, unknown>`.
 */
export type ExtractOkFromResult<R extends Result<unknown, unknown>> = Extract<
	R,
	{ error: null }
>;

/**
 * Utility type to extract the `Err<E>` variant from a `Result<T, E>` union type.
 *
 * If `R` is a `Result` type (e.g., `Result<string, Error>`), this type will resolve
 * to `Err<Error>`. This can be useful in generic contexts or for type narrowing.
 *
 * @template R - The `Result<T, E>` union type from which to extract the `Err<E>` variant.
 *             Must extend `Result<unknown, unknown>`.
 */
export type ExtractErrFromResult<R extends Result<unknown, unknown>> = Extract<
	R,
	{ data: null }
>;

/**
 * Utility type to extract the success value's type `T` from a `Result<T, E>` type.
 *
 * If `R` is an `Ok<T>` variant (or a `Result<T, E>` that could be an `Ok<T>`),
 * this type resolves to `T`. If `R` can only be an `Err<E>` variant, it resolves to `never`.
 * This is useful for obtaining the type of the `data` field when you know you have a success.
 *
 * @template R - The `Result<T, E>` type from which to extract the success value's type.
 *             Must extend `Result<unknown, unknown>`.
 * @example
 * ```ts
 * type MyResult = Result<number, string>;
 * type SuccessValueType = UnwrapOk<MyResult>; // SuccessValueType is number
 *
 * type MyErrorResult = Err<string>;
 * type ErrorValueType = UnwrapOk<MyErrorResult>; // ErrorValueType is never
 * ```
 */
export type UnwrapOk<R extends Result<unknown, unknown>> = R extends Ok<infer U>
	? U
	: never;

/**
 * Utility type to extract the error value's type `E` from a `Result<T, E>` type.
 *
 * If `R` is an `Err<E>` variant (or a `Result<T, E>` that could be an `Err<E>`),
 * this type resolves to `E`. If `R` can only be an `Ok<T>` variant, it resolves to `never`.
 * This is useful for obtaining the type of the `error` field when you know you have a failure.
 *
 * @template R - The `Result<T, E>` type from which to extract the error value's type.
 *             Must extend `Result<unknown, unknown>`.
 * @example
 * ```ts
 * type MyResult = Result<number, string>;
 * type ErrorValueType = UnwrapErr<MyResult>; // ErrorValueType is string
 *
 * type MySuccessResult = Ok<number>;
 * type SuccessValueType = UnwrapErr<MySuccessResult>; // SuccessValueType is never
 * ```
 */
export type UnwrapErr<R extends Result<unknown, unknown>> = R extends Err<
	infer E
>
	? E
	: never;

/**
 * Type guard to runtime check if an unknown value is a valid `Result<T, E>`.
 *
 * A value is considered a valid `Result` if:
 * 1. It is a non-null object.
 * 2. It has both `data` and `error` properties.
 * 3. At least one of the `data` or `error` channels is `null`. Both being `null` represents `Ok(null)`.
 *
 * This function does not validate the types of `data` or `error` beyond `null` checks.
 *
 * @template T - The expected type of the success value if the value is an `Ok` variant (defaults to `unknown`).
 * @template E - The expected type of the error value if the value is an `Err` variant (defaults to `unknown`).
 * @param value - The value to check.
 * @returns `true` if the value conforms to the `Result` structure, `false` otherwise.
 *          If `true`, TypeScript's type system will narrow `value` to `Result<T, E>`.
 * @example
 * ```ts
 * declare const someValue: unknown;
 *
 * if (isResult<string, Error>(someValue)) {
 *   // someValue is now typed as Result<string, Error>
 *   if (isOk(someValue)) {
 *     console.log(someValue.data); // string
 *   } else {
 *     console.error(someValue.error); // Error
 *   }
 * }
 * ```
 */
export function isResult<T = unknown, E = unknown>(
	value: unknown,
): value is Result<T, E> {
	const isNonNullObject = typeof value === "object" && value !== null;
	if (!isNonNullObject) return false;

	const hasDataProperty = "data" in value;
	const hasErrorProperty = "error" in value;
	if (!hasDataProperty || !hasErrorProperty) return false;

	const isNeitherNull = value.data !== null && value.error !== null;
	if (isNeitherNull) return false;

	// At least one channel is null (valid Result)
	return true;
}

/**
 * Type guard to runtime check if a `Result<T, E>` is an `Ok<T>` variant.
 *
 * This function narrows the type of a `Result` to `Ok<T>` if it represents a successful outcome.
 * An `Ok<T>` variant is identified by its `error` property being `null`.
 *
 * @template T - The success value type.
 * @template E - The error value type.
 * @param result - The `Result<T, E>` to check.
 * @returns `true` if the `result` is an `Ok<T>` variant, `false` otherwise.
 *          If `true`, TypeScript's type system will narrow `result` to `Ok<T>`.
 * @example
 * ```ts
 * declare const myResult: Result<number, string>;
 *
 * if (isOk(myResult)) {
 *   // myResult is now typed as Ok<number>
 *   console.log("Success value:", myResult.data); // myResult.data is number
 * }
 * ```
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
	return result.error === null;
}

/**
 * Type guard to runtime check if a `Result<T, E>` is an `Err<E>` variant.
 *
 * This function narrows the type of a `Result` to `Err<E>` if it represents a failure outcome.
 * An `Err<E>` variant is identified by its `error` property being non-`null` (and thus `data` being `null`).
 *
 * @template T - The success value type.
 * @template E - The error value type.
 * @param result - The `Result<T, E>` to check.
 * @returns `true` if the `result` is an `Err<E>` variant, `false` otherwise.
 *          If `true`, TypeScript's type system will narrow `result` to `Err<E>`.
 * @example
 * ```ts
 * declare const myResult: Result<number, string>;
 *
 * if (isErr(myResult)) {
 *   // myResult is now typed as Err<string>
 *   console.error("Error value:", myResult.error); // myResult.error is string
 * }
 * ```
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
	return result.error !== null; // Equivalent to result.data === null
}

/**
 * Executes a synchronous operation and wraps its outcome (success or failure) in a `Result<T, E>`.
 *
 * This function attempts to execute the `operation`.
 * - If `operation` completes successfully, its return value is wrapped in an `Ok<T>` variant.
 * - If `operation` throws an exception, the caught exception (of type `unknown`) is passed to
 *   the `mapErr` function. `mapErr` is responsible for transforming this `unknown`
 *   exception into an `Err<E>` variant containing a well-typed error value of type `E`.
 *
 * @template T - The type of the success value returned by the `operation` if it succeeds.
 * @template E - The type of the error value produced by `mapErr` if the `operation` fails.
 * @param options - An object containing the operation and error mapping function.
 * @param options.try - The synchronous operation to execute. This function is expected to return a value of type `T`.
 * @param options.mapErr - A function that takes the `unknown` exception caught from `options.try`
 *                        and transforms it into an `Err<E>` variant containing a specific error value of type `E`.
 * @returns A `Result<T, E>`: `Ok<T>` if `options.try` succeeds, or `Err<E>` if it throws and `options.mapErr` provides an error variant.
 * @example
 * ```ts
 * function parseJson(jsonString: string): Result<object, SyntaxError> {
 *   return trySync({
 *     try: () => JSON.parse(jsonString),
 *     mapErr: (err: unknown) => {
 *       if (err instanceof SyntaxError) return Err(err);
 *       return Err(new SyntaxError("Unknown parsing error"));
 *     }
 *   });
 * }
 *
 * const validResult = parseJson('{"name":"Result"}'); // Ok<{name: string}>
 * const invalidResult = parseJson('invalid json');    // Err<SyntaxError>
 *
 * if (isOk(validResult)) console.log(validResult.data);
 * if (isErr(invalidResult)) console.error(invalidResult.error.message);
 * ```
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
 * Executes an asynchronous operation (returning a `Promise`) and wraps its outcome in a `Promise<Result<T, E>>`.
 *
 * This function attempts to execute the asynchronous `operation`.
 * - If the `Promise` returned by `operation` resolves successfully, its resolved value is wrapped in an `Ok<T>` variant.
 * - If the `Promise` returned by `operation` rejects, or if `operation` itself throws an exception synchronously,
 *   the caught exception/rejection reason (of type `unknown`) is passed to the `mapErr` function.
 *   `mapErr` is responsible for transforming this `unknown` error into an `Err<E>` variant containing
 *   a well-typed error value of type `E`.
 *
 * The entire outcome (`Ok<T>` or `Err<E>`) is wrapped in a `Promise`.
 *
 * @template T - The type of the success value the `Promise` from `operation` resolves to.
 * @template E - The type of the error value produced by `mapErr` if the `operation` fails or rejects.
 * @param options - An object containing the asynchronous operation and error mapping function.
 * @param options.try - The asynchronous operation to execute. This function must return a `Promise<T>`.
 * @param options.mapErr - A function that takes the `unknown` exception/rejection reason caught from `options.try`
 *                        and transforms it into an `Err<E>` variant containing a specific error value of type `E`.
 *                        This function must return `Err<E>` directly.
 * @returns A `Promise` that resolves to a `Result<T, E>`: `Ok<T>` if `options.try`'s `Promise` resolves,
 *          or `Err<E>` if it rejects/throws and `options.mapErr` provides an error variant.
 * @example
 * ```ts
 * async function fetchData(url: string): Promise<Result<Response, Error>> {
 *   return tryAsync({
 *     try: async () => fetch(url),
 *     mapErr: (err: unknown) => {
 *       if (err instanceof Error) return Err(err);
 *       return Err(new Error("Network request failed"));
 *     }
 *   });
 * }
 *
 * async function processData() {
 *   const result = await fetchData("/api/data");
 *   if (isOk(result)) {
 *     const response = result.data;
 *     console.log("Data fetched:", await response.json());
 *   } else {
 *     console.error("Fetch error:", result.error.message);
 *   }
 * }
 * processData();
 * ```
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

/**
 * Resolves a value that may or may not be wrapped in a `Result`, returning the final value.
 *
 * This function handles the common pattern where a value might be a `Result<T, E>` or a plain `T`:
 * - If `value` is an `Ok<T>` variant, returns the contained success value.
 * - If `value` is an `Err<E>` variant, throws the contained error value.
 * - If `value` is not a `Result` (i.e., it's already a plain value of type `T`),
 *   returns it as-is.
 *
 * This is useful when working with APIs that might return either direct values or Results,
 * allowing you to normalize them to the actual value or propagate errors via throwing.
 *
 * Use `resolve` when the input might or might not be a Result.
 * Use `unwrap` when you know the input is definitely a Result.
 *
 * @template T - The type of the success value (if `value` is `Ok<T>`) or the type of the plain value.
 * @template E - The type of the error value (if `value` is `Err<E>`).
 * @param value - The value to resolve. Can be a `Result<T, E>` or a plain value of type `T`.
 * @returns The final value of type `T` if `value` is `Ok<T>` or if `value` is already a plain `T`.
 * @throws The error value `E` if `value` is an `Err<E>` variant.
 *
 * @example
 * ```ts
 * // Example with an Ok variant
 * const okResult = Ok("success data");
 * const resolved = resolve(okResult); // "success data"
 *
 * // Example with an Err variant
 * const errResult = Err(new Error("failure"));
 * try {
 *   resolve(errResult);
 * } catch (e) {
 *   console.error(e.message); // "failure"
 * }
 *
 * // Example with a plain value
 * const plainValue = "plain data";
 * const resolved = resolve(plainValue); // "plain data"
 *
 * // Example with a function that might return Result or plain value
 * declare function mightReturnResult(): string | Result<string, Error>;
 * const outcome = mightReturnResult();
 * try {
 *  const finalValue = resolve(outcome); // handles both cases
 *  console.log("Final value:", finalValue);
 * } catch (e) {
 *  console.error("Operation failed:", e);
 * }
 * ```
 */
/**
 * Unwraps a `Result<T, E>`, returning the success value or throwing the error.
 *
 * This function extracts the data from a `Result`:
 * - If the `Result` is an `Ok<T>` variant, returns the contained success value of type `T`.
 * - If the `Result` is an `Err<E>` variant, throws the contained error value of type `E`.
 *
 * Unlike `resolve`, this function expects the input to always be a `Result` type,
 * making it more direct for cases where you know you're working with a `Result`.
 *
 * @template T - The type of the success value contained in the `Ok<T>` variant.
 * @template E - The type of the error value contained in the `Err<E>` variant.
 * @param result - The `Result<T, E>` to unwrap.
 * @returns The success value of type `T` if the `Result` is `Ok<T>`.
 * @throws The error value of type `E` if the `Result` is `Err<E>`.
 *
 * @example
 * ```ts
 * // Example with an Ok variant
 * const okResult = Ok("success data");
 * const value = unwrap(okResult); // "success data"
 *
 * // Example with an Err variant
 * const errResult = Err(new Error("something went wrong"));
 * try {
 *   unwrap(errResult);
 * } catch (error) {
 *   console.error(error.message); // "something went wrong"
 * }
 *
 * // Usage in a function that returns Result
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return Err("Division by zero");
 *   return Ok(a / b);
 * }
 *
 * try {
 *   const result = unwrap(divide(10, 2)); // 5
 *   console.log("Result:", result);
 * } catch (error) {
 *   console.error("Division failed:", error);
 * }
 * ```
 */
export function unwrap<T, E>(result: Result<T, E>): T {
	if (isOk(result)) {
		return result.data;
	}
	throw result.error;
}

export function resolve<T, E>(value: T | Result<T, E>): T {
	if (isResult<T, E>(value)) {
		if (isOk(value)) {
			return value.data;
		}
		// If it's a Result and not Ok, it must be Err.
		// The type guard isResult<T,E>(value) and isOk(value) already refine the type.
		// So, 'value' here is known to be Err<E>.
		throw value.error;
	}

	// If it's not a Result type, return the value as-is.
	// 'value' here is known to be of type T.
	return value;
}
