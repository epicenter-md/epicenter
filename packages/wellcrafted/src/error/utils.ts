/**
 * Extracts a readable error message from an unknown error value
 *
 * This utility is commonly used in mapError functions when converting
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
 * // Used in mapError function
 * const result = await tryAsync({
 *   try: () => riskyOperation(),
 *   mapError: (error): NetworkError => ({
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
