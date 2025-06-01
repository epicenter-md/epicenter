/**
 * Extracts a readable error message from an unknown error value
 *
 * @param error - The unknown error to extract a message from
 * @returns A string representation of the error
 *
 * @example
 * ```ts
 * const error = new Error("Something went wrong");
 * const message = extractErrorMessage(error); // "Something went wrong"
 *
 * const stringError = "String error";
 * const message2 = extractErrorMessage(stringError); // "String error"
 *
 * const unknownError = { code: 500, details: "Server error" };
 * const message3 = extractErrorMessage(unknownError); // '{"code":500,"details":"Server error"}'
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
