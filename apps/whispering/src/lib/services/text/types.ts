import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { MaybePromise, WhisperingError } from '$lib/result';

const { TextServiceError, TextServiceErr } =
	createTaggedError('TextServiceError');
type TextServiceError = ReturnType<typeof TextServiceError>;
export { TextServiceErr, TextServiceError };

export type TextService = {
	/**
	 * Reads text from the system clipboard.
	 * @returns The text content of the clipboard, or null if empty.
	 */
	readFromClipboard: () => Promise<Result<string | null, TextServiceError>>;

	/**
	 * Copies text to the system clipboard.
	 * @param text The text to copy to the clipboard.
	 */
	copyToClipboard: (text: string) => Promise<Result<void, TextServiceError>>;

	/**
	 * Writes the provided text at the current cursor position.
	 * Uses the clipboard sandwich technique to preserve the user's existing clipboard content.
	 *
	 * This method:
	 * 1. Saves the current clipboard
	 * 2. Writes the text to clipboard
	 * 3. Simulates paste (Cmd+V on macOS, Ctrl+V elsewhere)
	 * 4. Restores the original clipboard
	 *
	 * @param text The text to write at the cursor position.
	 */
	writeToCursor: (
		text: string,
	) => MaybePromise<Result<void, TextServiceError | WhisperingError>>;
};
