import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { NotificationService, UnifiedNotificationOptions } from './types';
import {
	NotificationServiceErr,
	toBrowserNotification,
	toExtensionNotification,
} from './types';

/**
 * Creates a web-based notification service that handles browser notifications
 * with fallback support for extension-based notifications.
 *
 * @returns {NotificationService} A notification service instance with notify and clear methods
 */
export function createNotificationServiceWeb(): NotificationService {
	// Cache extension detection result
	let extensionChecked = false;
	let hasExtension = false;

	/**
	 * Detects if a browser extension is available for enhanced notification support.
	 * Results are cached to avoid repeated detection attempts.
	 *
	 * @returns {Promise<boolean>} True if extension is available, false otherwise
	 */
	const detectExtension = async (): Promise<boolean> => {
		if (extensionChecked) return hasExtension;

		// TODO: Implement real extension detection
		// This would involve sending a ping message to the extension
		// and waiting for a response with a timeout
		// For now, always use browser API
		hasExtension = false;
		extensionChecked = true;
		return hasExtension;
	};

	return {
		/**
		 * Sends a notification using the best available method (extension or browser API).
		 * Automatically handles permission requests and converts unified options to browser format.
		 *
		 * @param {UnifiedNotificationOptions} options - Notification configuration including title, body, and actions
		 * @returns {Promise<Result<string, NotificationServiceError>>} Success with notification ID or error
		 */
		async notify(options: UnifiedNotificationOptions) {
			const notificationId = options.id ?? nanoid();

			// Try extension first if available
			if (await detectExtension()) {
				// Extension notification path (for future implementation)
				// const extensionOptions = toExtensionNotification(options);
				// const { error } = await tryAsync({
				//   try: async () => {
				//     await extension.createNotification({
				//       ...extensionOptions,
				//       notificationId,
				//     });
				//   },
				//   catch: (error) => ({
				//     name: 'NotificationServiceError' as const,
				//     message: 'Failed to send extension notification',
				//     cause: error,
				//   }),
				// });
				// if (!error) return Ok(notificationId);
			}

			// Browser notification fallback
			const { error } = await tryAsync({
				try: async () => {
					// Check if browser supports notifications
					const isNotificationsSupported = 'Notification' in window;
					if (!isNotificationsSupported) {
						throw new Error('Browser does not support notifications');
					}

					// Check/request permission
					let permission = Notification.permission;
					if (permission === 'default') {
						permission = await Notification.requestPermission();
					}

					if (permission !== 'granted') {
						throw new Error('Notification permission denied');
					}

					// Create notification
					const browserOptions = toBrowserNotification(options);
					const notification = new Notification(options.title, browserOptions);

					// Handle notification click if there's a link action
					if (options.action?.type === 'link') {
						const linkAction = options.action;
						notification.onclick = () => {
							window.location.href = linkAction.href;
							notification.close();
						};
					}
				},
				catch: (error) =>
					NotificationServiceErr({
						message: 'Failed to send browser notification',
						context: { notificationId, title: options.title },
						cause: error,
					}),
			});

			if (error) return Err(error);
			return Ok(notificationId);
		},

		/**
		 * Clears a notification by ID. Currently a no-op for browser notifications
		 * as they don't provide a direct clear API.
		 *
		 * @param {string} id - The notification ID to clear
		 * @returns {Promise<Result<undefined, NotificationServiceError>>} Success or error result
		 */
		async clear(id: string) {
			// Browser notifications don't have a direct clear API
			// They auto-dismiss or require service worker control
			// For future extension support:
			// if (await detectExtension()) {
			//   const { error } = await extension.clearNotification({ notificationId: id });
			//   if (error) return Err(error);
			// }
			return Ok(undefined);
		},
	};
}
