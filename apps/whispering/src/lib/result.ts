import type { TaggedError } from 'wellcrafted/error';
import { Err, type Ok } from 'wellcrafted/result';
import type { UnifiedNotificationOptions } from '$lib/services/notifications/types';

/**
 * Custom error type for the Whispering application that combines error information
 * with notification display options. This error type is designed to be user-facing,
 * providing both error details and UI presentation information.
 */
export type WhisperingError = Omit<
	TaggedError<'WhisperingError'>,
	'message' | 'cause' | 'context'
> &
	Omit<UnifiedNotificationOptions, 'variant'> & {
		severity: 'error' | 'warning';
	};

/**
 * Creates a WhisperingError with 'error' severity.
 * This is the primary factory function for creating error objects in the application.
 */
const WhisperingError = (
	args: Omit<WhisperingError, 'name' | 'severity'>,
): WhisperingError => ({ name: 'WhisperingError', severity: 'error', ...args });

/**
 * Creates a Err wrapping a WhisperingError.
 */
export const WhisperingErr = (
	args: Omit<WhisperingError, 'name' | 'severity'>,
) => Err(WhisperingError(args));

/**
 * Creates a WhisperingError with 'warning' severity.
 */
const WhisperingWarning = (
	args: Omit<WhisperingError, 'name' | 'severity'>,
): WhisperingError => ({
	name: 'WhisperingError',
	severity: 'warning',
	...args,
});

/**
 * Creates a Err wrapping a WhisperingError with 'warning' severity.
 */
export const WhisperingWarningErr = (
	args: Omit<WhisperingError, 'name' | 'severity'>,
) => Err(WhisperingWarning(args));

/**
 * Result type for Whispering operations that can fail.
 * Follows the Result pattern where operations return either Ok<T> or Err<WhisperingError>.
 *
 * @template T - The type of the success value
 */
export type WhisperingResult<T> = Ok<T> | Err<WhisperingError>;

/**
 * Utility type for values that may or may not be wrapped in a Promise.
 * Useful for functions that can be either synchronous or asynchronous.
 *
 * @template T - The type that may or may not be wrapped in a Promise
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Adapts a TaggedError from lower-level libraries into a WhisperingError for user-facing notifications.
 * The error's message becomes the description, while you provide the title and display options.
 *
 * Commonly used with notify.error.execute() to show errors in the UI.
 *
 * @param error - The TaggedError to adapt (from services or libraries)
 * @param opts - Display options (title, action, etc.)
 * @returns A WhisperingError ready for notification display
 *
 * @example
 * ```typescript
 * // Pass to notification system for display
 * const { data, error } = await services.someOperation();
 * if (error) {
 *   notify.error.execute(
 *     adaptTaggedError(error, {
 *       title: 'Operation Failed',
 *       action: { type: 'more-details', error }
 *     })
 *   );
 * }
 * ```
 */
export const fromTaggedError = (
	error: TaggedError<string>,
	opts: Omit<Parameters<typeof WhisperingError>[0], 'description'>,
): WhisperingError => WhisperingError({ ...opts, description: error.message });

/**
 * Adapts a TaggedError into an Err Result containing a WhisperingError.
 * Convenience wrapper that combines adaptTaggedError with Err wrapping.
 *
 * Use in query layer functions to transform service errors into user-facing errors.
 *
 * @param error - The TaggedError to adapt (from services or libraries)
 * @param opts - Display options (title, action, etc.)
 * @returns An Err Result containing the adapted WhisperingError
 *
 * @example
 * ```typescript
 * // In query layer, transform service errors
 * const { data: recordingId, error } = await services.recorder.start();
 * if (error) {
 *   return adaptTaggedErr(error, {
 *     title: '❌ Failed to start recording',
 *     action: { type: 'more-details', error }
 *   });
 * }
 * return Ok(recordingId);
 * ```
 */
export const fromTaggedErr = (
	error: TaggedError<string>,
	opts: Omit<Parameters<typeof WhisperingError>[0], 'description'>,
) => Err(fromTaggedError(error, opts));
