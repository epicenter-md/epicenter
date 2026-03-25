import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { NotificationService, UnifiedNotificationOptions } from './types';
import { NotificationError, toBrowserNotification } from './types';

/**
 * Creates a web-based notification service that handles browser notifications
 * with fallback support for extension-based notifications.
 */
export function createNotificationServiceWeb(): NotificationService {
	// Cache extension detection result
	let extensionChecked = false;
	let hasExtension = false;

	/**
	 * Detects if a browser extension is available for enhanced notification support.
	 * Results are cached to avoid repeated detection attempts.
	 */
	const detectExtension = async (): Promise<boolean> => {
		if (extensionChecked) return hasExtension;

		hasExtension = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				window.removeEventListener('message', onPong);
				resolve(false);
			}, 200);

			function onPong(event: MessageEvent) {
				if (
					event.source === window &&
					event.data?.type === 'whispering-extension-pong'
				) {
					clearTimeout(timer);
					window.removeEventListener('message', onPong);
					resolve(true);
				}
			}

			window.addEventListener('message', onPong);
			window.postMessage({ type: 'whispering-extension-ping' }, '*');
		});

		extensionChecked = true;
		return hasExtension;
	};

	return {
		/**
		 * Sends a notification using the best available method (extension or browser API).
		 * Automatically handles permission requests and converts unified options to browser format.
		 *
		 * @param options - Notification configuration including title, body, and actions
		 */
		async notify(options: UnifiedNotificationOptions) {
			const notificationId = options.id ?? nanoid();

			// Try extension first if available
			if (await detectExtension()) {
				// Future: Extension notification support
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
				catch: (error) => NotificationError.SendFailed({ cause: error }),
			});

			if (error) return Err(error);
			return Ok(notificationId);
		},

		/**
		 * Clears a notification by ID. Currently a no-op for browser notifications
		 * as they don't provide a direct clear API.
		 *
		 * @param _id - The notification ID to clear (unused, browser notifications auto-dismiss)
		 */
		async clear(_id: string) {
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
