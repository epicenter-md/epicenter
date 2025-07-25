import type { TaggedError } from "./types.js";
import { Err } from "../result/result.js";

/**
 * Extracts a readable error message from an unknown error value
 *
 * This utility is commonly used in mapErr functions when converting
 * unknown errors to typed error objects in the Result system.
 *
 * @param error - The unknown error to extract a message from
 * @returns A string representation of the error
 *
 * @example
 * ```ts
 * // With native Error
 * const error = new Error("Something went wrong");
 * const message = extractErrorMessage(error); // "Something went wrong"
 *
 * // With string error
 * const stringError = "String error";
 * const message2 = extractErrorMessage(stringError); // "String error"
 *
 * // With object error
 * const unknownError = { code: 500, details: "Server error" };
 * const message3 = extractErrorMessage(unknownError); // '{"code":500,"details":"Server error"}'
 *
 * // Used in mapErr function
 * const result = await tryAsync({
 *   try: () => riskyOperation(),
 *   mapErr: (error) => Err({
 *     name: "NetworkError",
 *     message: extractErrorMessage(error),
 *     context: { operation: "riskyOperation" },
 *     cause: error,
 *   }),
 * });
 * ```
 */
export function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	if (typeof error === "object" && error !== null) {
		// Check for common error properties
		const errorObj = error as Record<string, unknown>;
		if (typeof errorObj.message === "string") {
			return errorObj.message;
		}
		if (typeof errorObj.error === "string") {
			return errorObj.error;
		}
		if (typeof errorObj.description === "string") {
			return errorObj.description;
		}

		// Fallback to JSON stringification
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}

	return String(error);
}

/**
 * Input type for creating a tagged error (everything except the name)
 */
type TaggedErrorWithoutName<T extends string> = Omit<TaggedError<T>, "name">;

/**
 * Replaces the "Error" suffix with "Err" suffix in error type names.
 *
 * This utility type is used to create companion function names for error constructors
 * that return Err-wrapped results, maintaining consistent naming conventions.
 *
 * @template T - An error type name that must end with "Error"
 * @returns The type name with "Error" replaced by "Err"
 *
 * @example
 * ```ts
 * type NetworkErr = ReplaceErrorWithErr<"NetworkError">; // "NetworkErr"
 * type ValidationErr = ReplaceErrorWithErr<"ValidationError">; // "ValidationErr"
 * type AuthErr = ReplaceErrorWithErr<"AuthError">; // "AuthErr"
 * ```
 */
type ReplaceErrorWithErr<T extends `${string}Error`> =
	T extends `${infer TBase}Error` ? `${TBase}Err` : never;

/**
 * Return type for createTaggedError - contains both factory functions.
 *
 * Provides two factory functions:
 * - One that creates plain TaggedError objects (named with "Error" suffix)
 * - One that creates Err-wrapped TaggedError objects (named with "Err" suffix)
 */
type TaggedErrorFactories<TErrorName extends `${string}Error`> = {
	[K in TErrorName]: (input: TaggedErrorWithoutName<K>) => TaggedError<K>;
} & {
	[K in ReplaceErrorWithErr<TErrorName>]: (
		input: TaggedErrorWithoutName<TErrorName>,
	) => Err<TaggedError<TErrorName>>;
};

/**
 * Returns two different factory functions for tagged errors.
 *
 * Given an error name like "NetworkError", this returns:
 * - `NetworkError`: Creates a plain TaggedError object
 * - `NetworkErr`: Creates a TaggedError object wrapped in an Err result
 *
 * The naming pattern automatically replaces the "Error" suffix with "Err" suffix
 * for the Result-wrapped version.
 *
 * @param name - The name of the error type (must end with "Error")
 * @returns An object with two factory functions:
 *   - [name]: Function that creates plain TaggedError objects
 *   - [name with "Error" replaced by "Err"]: Function that creates Err-wrapped TaggedError objects
 *
 * @example
 * ```ts
 * const { NetworkError, NetworkErr } = createTaggedError('NetworkError');
 *
 * // NetworkError: Creates just the error object
 * const error = NetworkError({
 *   message: 'Connection failed',
 *   context: { url: 'https://api.example.com' },
 *   cause: undefined
 * });
 * // Returns: { name: 'NetworkError', message: 'Connection failed', ... }
 *
 * // NetworkErr: Creates error and wraps in Err result
 * return NetworkErr({
 *   message: 'Connection failed',
 *   context: { url: 'https://api.example.com' },
 *   cause: undefined
 * });
 * // Returns: Err({ name: 'NetworkError', message: 'Connection failed', ... })
 * ```
 */
export function createTaggedError<TErrorName extends `${string}Error`>(
	name: TErrorName,
): TaggedErrorFactories<TErrorName> {
	const errorConstructor = (
		error: TaggedErrorWithoutName<TErrorName>,
	): TaggedError<TErrorName> => ({ ...error, name }) as TaggedError<TErrorName>;

	const errName = name.replace(
		/Error$/,
		"Err",
	) as ReplaceErrorWithErr<TErrorName>;
	const errConstructor = (error: TaggedErrorWithoutName<TErrorName>) =>
		Err(errorConstructor(error));

	return {
		[name]: errorConstructor,
		[errName]: errConstructor,
	} as TaggedErrorFactories<TErrorName>;
}
