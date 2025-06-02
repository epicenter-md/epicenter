import { tryAsync, trySync } from "../result.js";
import { extractErrorMessage } from "./utils.js";

export type BaseError = Readonly<{
	name: string;
	message: string;
	context: Record<string, unknown>;
	cause: unknown;
}>;

/**
 * Creates a tagged error type for type-safe error handling.
 * Uses the `name` property as a discriminator for tagged unions.
 *
 * Error types should follow the convention of ending with "Error" suffix.
 * The Err data structure wraps these error types in the Result system.
 *
 * @example
 * ```ts
 * type ValidationError = TaggedError<"ValidationError">
 * type NetworkError = TaggedError<"NetworkError">
 *
 * function handleError(error: ValidationError | NetworkError) {
 *   switch (error.name) {
 *     case "ValidationError": // TypeScript knows this is ValidationError
 *       break;
 *     case "NetworkError": // TypeScript knows this is NetworkError
 *       break;
 *   }
 * }
 *
 * // Used in Result types:
 * function validate(input: string): Result<string, ValidationError> {
 *   if (!input) {
 *     return Err({
 *       name: "ValidationError",
 *       message: "Input is required",
 *       context: { input },
 *       cause: null,
 *     });
 *   }
 *   return Ok(input);
 * }
 * ```
 */
export type TaggedError<T extends string> = BaseError & {
	readonly name: T;
};

export function createTryFns<TName extends string>(name: TName) {
	type TError = TaggedError<TName>;
	return {
		trySync: <T>({
			try: operation,
			mapErr,
		}: {
			try: () => T;
			mapErr: (error: unknown) => Omit<TError, "name">;
		}) =>
			trySync<T, TError>({
				try: operation,
				mapErr: (error) => ({
					...mapErr(error),
					name,
				}),
			}),
		tryAsync: <T>({
			try: operation,
			mapErr,
		}: {
			try: () => Promise<T>;
			mapErr: (error: unknown) => Omit<TError, "name">;
		}) =>
			tryAsync<T, TError>({
				try: operation,
				mapErr: (error) => ({ ...mapErr(error), name }),
			}),
	};
}
