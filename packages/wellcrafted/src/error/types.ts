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
 * ```
 */
export type TaggedError<T extends string> = BaseError & {
	readonly name: T;
};
