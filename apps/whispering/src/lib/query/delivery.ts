import { WHISPERING_RECORDINGS_PATHNAME } from '$lib/constants/app';
import { settings } from '$lib/stores/settings.svelte';
import { shouldTriggerEnterOnOver, removeOverFromEnd } from '$lib/utils/transcription-triggers';
import { Ok } from 'wellcrafted/result';
import { defineMutation } from './_client';
import { rpc } from './index';
import type { TextServiceError } from '$lib/services/text';
import type { WhisperingError } from '$lib/result';

export const delivery = {
	/**
	 * Delivers transcribed text to the user according to their text output preferences.
	 *
	 * This mutation handles the complete delivery workflow for transcription results:
	 * 1. Shows a success toast with the transcribed text
	 * 2. Optionally copies text to clipboard based on user settings
	 * 3. Optionally writes text to cursor based on user settings
	 * 4. Provides fallback UI actions when automatic operations fail
	 *
	 * The user's preferences are read from:
	 * - `transcription.copyToClipboardOnSuccess` - Whether to auto-copy
	 * - `transcription.writeToCursorOnSuccess` - Whether to auto-write to cursor
	 *
	 * @param text - The transcribed text to deliver
	 * @param toastId - Unique ID for toast notifications to prevent duplicates
	 * @returns Result with no meaningful data (fire-and-forget operation)
	 *
	 * @example
	 * ```typescript
	 * // After transcription completes
	 * await rpc.delivery.deliverTranscriptionResult.execute({
	 *   text: transcribedText,
	 *   toastId: nanoid()
	 * });
	 * ```
	 */
	deliverTranscriptionResult: defineMutation({
		mutationKey: ['delivery', 'deliverTranscriptionResult'],
		resultMutationFn: async ({
			text,
			toastId,
		}: {
			text: string;
			toastId: string;
		}) => {
			// Check if text ends with "Over" to trigger Enter after delivery
			const shouldPressEnter = shouldTriggerEnterOnOver(text);

			// Remove "Over" from the text if present before delivering
			const cleanedText = shouldPressEnter ? removeOverFromEnd(text) : text;

			// Track what operations succeeded
			let copied = false;
			let written = false;

			// Shows transcription result and offers manual copy action
			const offerManualCopy = () =>
				rpc.notify.success.execute({
					id: toastId,
					title: '📝 Recording transcribed!',
					description: cleanedText,
					action: {
						type: 'button',
						label: 'Copy to clipboard',
						onClick: async () => {
							const { error } = await rpc.text.copyToClipboard.execute({
								text: cleanedText,
							});
							if (error) {
								// Report that manual copy attempt failed
								rpc.notify.error.execute({
									title: 'Error copying transcribed text to clipboard',
									description: error.message,
									action: { type: 'more-details', error },
								});
								return;
							}
							// Confirm manual copy succeeded
							rpc.notify.success.execute({
								id: toastId,
								title: 'Copied transcribed text to clipboard!',
								description: cleanedText,
							});
						},
					},
				});

			// Warns that automatic copy failed
			const warnAutoCopyFailed = (error: TextServiceError) => {
				rpc.notify.warning.execute({
					title: "Couldn't copy to clipboard",
					description: error.message,
					action: { type: 'more-details', error },
				});
			};

			// Warns that write to cursor failed
			const warnWriteToCursorFailed = (
				error: TextServiceError | WhisperingError,
			) => {
				if (error.name === 'TextServiceError') {
					rpc.notify.warning.execute({
						title: 'Unable to write to cursor automatically',
						description: error.message,
						action: { type: 'more-details', error },
					});
					return;
				}
				if (error.name === 'WhisperingError') {
					rpc.notify[error.severity].execute(error);
					return;
				}
			};

			// Show appropriate success notification based on what succeeded
			const showSuccessNotification = () => {
				if (copied && written) {
					// Both operations succeeded
					rpc.notify.success.execute({
						id: toastId,
						title: '📝 Recording transcribed, copied to clipboard, and written to cursor!',
						description: cleanedText,
						action: {
							type: 'link',
							label: 'Go to recordings',
							href: WHISPERING_RECORDINGS_PATHNAME,
						},
					});
				} else if (copied) {
					// Only copy succeeded
					rpc.notify.success.execute({
						id: toastId,
						title: '📝 Recording transcribed and copied to clipboard!',
						description: cleanedText,
						action: {
							type: 'link',
							label: 'Go to recordings',
							href: WHISPERING_RECORDINGS_PATHNAME,
						},
					});
				} else if (written) {
					// Only write succeeded
					rpc.notify.success.execute({
						id: toastId,
						title: '📝 Recording transcribed and written to cursor!',
						description: cleanedText,
						action: {
							type: 'link',
							label: 'Go to recordings',
							href: WHISPERING_RECORDINGS_PATHNAME,
						},
					});
				} else {
					// Neither succeeded, offer manual copy
					offerManualCopy();
				}
			};

			// Main delivery flow - operations are independent

			// Check if user wants to copy to clipboard
			if (settings.value['transcription.copyToClipboardOnSuccess']) {
				const { error: copyError } = await rpc.text.copyToClipboard.execute({
					text: cleanedText,
				});
				if (!copyError) {
					copied = true;
				} else {
					warnAutoCopyFailed(copyError);
				}
			}

			// Check if user wants to write to cursor (independent of copy)
			if (settings.value['transcription.writeToCursorOnSuccess']) {
				const { error: writeError } = await rpc.text.writeToCursor.execute({
					text: cleanedText,
				});
				if (!writeError) {
					written = true;
				} else {
					warnWriteToCursorFailed(writeError);
				}
			}

			// Show appropriate notification
			showSuccessNotification();

			// Press Enter if "Over" was detected at the end of the original text
			if (shouldPressEnter) {
				// Small delay to ensure any clipboard operations complete
				await new Promise(resolve => setTimeout(resolve, 200));

				const { error: pressEnterError } = await rpc.text.pressEnter.execute(undefined);
				if (pressEnterError) {
					// Log the error but don't disrupt the main flow
					console.warn('Failed to automatically press Enter after "Over" detection:', pressEnterError);
				} else {
					console.info('Automatically pressed Enter after detecting and removing "Over" from transcription');
				}
			}

			return Ok(undefined);
		},
	}),

	/**
	 * Delivers transformed text to the user according to their text output preferences.
	 *
	 * This mutation handles the complete delivery workflow for transformation results:
	 * 1. Shows a success toast with the transformed text
	 * 2. Optionally copies text to clipboard based on user settings
	 * 3. Optionally writes text to cursor based on user settings
	 * 4. Provides fallback UI actions when automatic operations fail
	 *
	 * The user's preferences are read from:
	 * - `transformation.copyToClipboardOnSuccess` - Whether to auto-copy
	 * - `transformation.writeToCursorOnSuccess` - Whether to auto-write to cursor
	 *
	 * @param text - The transformed text to deliver
	 * @param toastId - Unique ID for toast notifications to prevent duplicates
	 * @returns Result with no meaningful data (fire-and-forget operation)
	 *
	 * @example
	 * ```typescript
	 * // After transformation completes
	 * await rpc.delivery.deliverTransformationResult.execute({
	 *   text: transformedText,
	 *   toastId: nanoid()
	 * });
	 * ```
	 */
	deliverTransformationResult: defineMutation({
		mutationKey: ['delivery', 'deliverTransformationResult'],
		resultMutationFn: async ({
			text,
			toastId,
		}: {
			text: string;
			toastId: string;
		}) => {
			// Track what operations succeeded
			let copied = false;
			let written = false;

			// Shows transformation result and offers manual copy action
			const offerManualCopy = () =>
				rpc.notify.success.execute({
					id: toastId,
					title: '🔄 Transformation complete!',
					description: text,
					action: {
						type: 'button',
						label: 'Copy to clipboard',
						onClick: async () => {
							const { error } = await rpc.text.copyToClipboard.execute({
								text,
							});
							if (error) {
								// Report that manual copy attempt failed
								rpc.notify.error.execute({
									title: 'Error copying transformed text to clipboard',
									description: error.message,
									action: { type: 'more-details', error },
								});
								return;
							}
							// Confirm manual copy succeeded
							rpc.notify.success.execute({
								id: toastId,
								title: 'Copied transformed text to clipboard!',
								description: text,
							});
						},
					},
				});

			// Warns that automatic copy failed
			const warnAutoCopyFailed = (error: TextServiceError) => {
				rpc.notify.warning.execute({
					title: "Couldn't copy to clipboard",
					description: error.message,
					action: { type: 'more-details', error },
				});
			};

			// Warns that write to cursor failed
			const warnWriteToCursorFailed = (
				error: TextServiceError | WhisperingError,
			) => {
				if (error.name === 'TextServiceError') {
					rpc.notify.error.execute({
						title: 'Error writing transformed text to cursor',
						description: error.message,
						action: { type: 'more-details', error },
					});
					return;
				}
				if (error.name === 'WhisperingError') {
					rpc.notify[error.severity].execute(error);
					return;
				}
			};

			// Show appropriate success notification based on what succeeded
			const showSuccessNotification = () => {
				if (copied && written) {
					// Both operations succeeded
					rpc.notify.success.execute({
						id: toastId,
						title: '🔄 Transformation complete, copied to clipboard, and written to cursor!',
						description: text,
						action: {
							type: 'link',
							label: 'Go to recordings',
							href: WHISPERING_RECORDINGS_PATHNAME,
						},
					});
				} else if (copied) {
					// Only copy succeeded
					rpc.notify.success.execute({
						id: toastId,
						title: '🔄 Transformation complete and copied to clipboard!',
						description: text,
						action: {
							type: 'link',
							label: 'Go to recordings',
							href: WHISPERING_RECORDINGS_PATHNAME,
						},
					});
				} else if (written) {
					// Only write succeeded
					rpc.notify.success.execute({
						id: toastId,
						title: '🔄 Transformation complete and written to cursor!',
						description: text,
						action: {
							type: 'link',
							label: 'Go to recordings',
							href: WHISPERING_RECORDINGS_PATHNAME,
						},
					});
				} else {
					// Neither succeeded, offer manual copy
					offerManualCopy();
				}
			};

			// Main delivery flow - operations are independent

			// Check if user wants to copy to clipboard
			if (settings.value['transformation.copyToClipboardOnSuccess']) {
				const { error: copyError } = await rpc.text.copyToClipboard.execute({
					text,
				});
				if (!copyError) {
					copied = true;
				} else {
					warnAutoCopyFailed(copyError);
				}
			}

			// Check if user wants to write to cursor (independent of copy)
			if (settings.value['transformation.writeToCursorOnSuccess']) {
				const { error: writeError } = await rpc.text.writeToCursor.execute({
					text,
				});
				if (!writeError) {
					written = true;
				} else {
					warnWriteToCursorFailed(writeError);
				}
			}

			// Show appropriate notification
			showSuccessNotification();

			return Ok(undefined);
		},
	}),
};