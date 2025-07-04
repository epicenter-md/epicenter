/**
 * Base error structure for all errors in the Result system.
 *
 * Provides a consistent structure for error objects that are JSON-serializable
 * and contain comprehensive debugging information.
 *
 * @example
 * ```ts
 * const error: BaseError = {
 *   name: "DatabaseError",
 *   message: "Connection failed",
 *   context: { host: "localhost", port: 5432 },
 *   cause: originalError
 * };
 * ```
 */
export type BaseError = Readonly<{
	name: string;
	message: string;
	context?: Record<string, unknown>;
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
 *
 * // Context is optional - omit when not needed:
 * function checkAuth(): Result<User, AuthError> {
 *   if (!isAuthenticated) {
 *     return Err({
 *       name: "AuthError",
 *       message: "User not authenticated",
 *       cause: null,
 *     });
 *   }
 *   return Ok(currentUser);
 * }
 * ```
 */
export type TaggedError<T extends string> = BaseError & {
	readonly name: T;
};
