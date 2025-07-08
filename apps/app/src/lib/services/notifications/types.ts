import type { Options as TauriNotificationOptions } from '@tauri-apps/plugin-notification';
import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Platform-Specific Notification Transformations
 *
 * This file centralizes all transformations from UnifiedNotificationOptions
 * to platform-specific notification formats. This makes it easy to see how
 * our unified API maps to each platform's requirements.
 *
 * Supported platforms:
 * - Tauri (Desktop): Uses numeric IDs, supports basic notifications
 * - Browser: Standard Notification API, limited action support
 * - Extension (Future): Chrome extension API, full action support
 */

const { NotificationServiceError, NotificationServiceErr } = createTaggedError(
	'NotificationServiceError',
);
export type NotificationServiceError = ReturnType<
	typeof NotificationServiceError
>;
export { type NotificationServiceError, NotificationServiceErr };

/**
 * Link action for internal navigation
 * @note The href must be a local path within the app, not an external URL
 */
type LinkAction = {
	type: 'link';
	label: string;
	href: `/${string}`; // Must be a local path like '/settings' or '/recordings/123'
};

/**
 * Button action for custom callbacks
 */
type ButtonAction = {
	type: 'button';
	label: string;
	onClick: () => void | Promise<void>;
};

/**
 * More details action for showing additional information (e.g., error details)
 */
type MoreDetailsAction = {
	type: 'more-details';
	error: unknown; // Can be Error object or any error data
};

type NotificationAction = LinkAction | ButtonAction | MoreDetailsAction;

export type UnifiedNotificationOptions = {
	/**
	 * Unique identifier
	 * @toast Maps to ExternalToast.id
	 * @browser Maps to tag
	 * @extension Used as notificationId
	 * @tauri Maps to Options.id (as number)
	 */
	id?: string;

	/**
	 * Main notification title
	 * @all Supported on all platforms
	 */
	title: string;

	/**
	 * Notification body text
	 * @toast Maps to ExternalToast.description
	 * @browser Maps to body
	 * @extension Maps to message
	 * @tauri Maps to Options.body
	 */
	description: string;

	/**
	 * Notification icon
	 * @toast Not used (uses variant styling)
	 * @browser Maps to icon
	 * @extension Maps to iconUrl
	 * @tauri Maps to Options.icon
	 */
	icon?: string;

	/**
	 * Keep notification visible until dismissed
	 * @toast Not applicable
	 * @browser Maps to requireInteraction
	 * @extension Maps to requireInteraction
	 * @tauri Maps to Options.autoCancel (inverse)
	 */
	requireInteraction?: boolean;

	/**
	 * Silent notification (no sound)
	 * @toast Not applicable
	 * @browser Maps to silent
	 * @extension Maps via priority: -2
	 * @tauri Maps to Options.silent
	 */
	silent?: boolean;

	/**
	 * Interactive action
	 * @toast Full support via ExternalToast.action (single action only)
	 * @browser Maps to actions[0] (Service Worker only)
	 * @extension Maps to buttons[0]
	 * @tauri Not supported on desktop
	 */
	action?: NotificationAction;

	/**
	 * Toast-specific variant
	 * @toast Maps to type via toast[variant]() methods
	 * @others Ignored
	 */
	variant: 'success' | 'error' | 'warning' | 'info' | 'loading';

	/**
	 * Keep toast visible indefinitely until manually dismissed
	 * @toast Uses Infinity duration in Sonner
	 * @note Only applies to toast notifications, not OS notifications
	 */
	persist?: boolean;
};

export type NotificationService = {
	notify: (
		options: UnifiedNotificationOptions,
	) => Promise<Result<string, NotificationServiceError>>;
	clear: (id: string) => Promise<Result<void, NotificationServiceError>>;
};

/**
 * Transform UnifiedNotificationOptions to Tauri notification options
 *
 * Mappings:
 * - id: String → Number (via hash function)
 * - description → body
 * - requireInteraction → autoCancel (inverted)
 * - actions: Not supported on desktop
 * - variant: Ignored (only for toasts)
 */
export function toTauriNotification(
	options: UnifiedNotificationOptions,
): TauriNotificationOptions {
	return {
		id: options.id ? hashNanoidToNumber(options.id) : undefined,
		title: options.title,
		body: options.description,
		icon: options.icon,
		silent: options.silent,
		autoCancel: !options.requireInteraction,
	};
}

/**
 * Transform UnifiedNotificationOptions to browser Notification API options
 *
 * Mappings:
 * - id → tag
 * - description → body
 * - Direct mappings: icon, requireInteraction, silent
 * - actions: Only work in Service Workers (limited support)
 * - variant: Ignored (only for toasts)
 */
export function toBrowserNotification(
	options: UnifiedNotificationOptions,
): NotificationOptions {
	return {
		body: options.description,
		icon: options.icon,
		tag: options.id,
		requireInteraction: options.requireInteraction,
		silent: options.silent,
	};
}

/**
 * Transform UnifiedNotificationOptions to Chrome extension notification options
 *
 * Mappings:
 * - description → message
 * - icon → iconUrl (with fallback)
 * - silent → priority (-2 for silent, 0 for normal)
 * - action → buttons[0] (single button, excludes 'more-details')
 * - variant: Ignored (only for toasts)
 *
 * @future This will be implemented when extension support is added
 */
export function toExtensionNotification(
	options: UnifiedNotificationOptions,
): ChromeNotificationOptions {
	return {
		type: 'basic',
		title: options.title,
		message: options.description,
		iconUrl: options.icon || '/icon-192.png',
		requireInteraction: options.requireInteraction,
		priority: options.silent ? -2 : 0,
		buttons:
			options.action && options.action.type !== 'more-details'
				? [{ title: options.action.label }]
				: undefined,
	};
}

/**
 * Chrome extension notification options type
 * @future This type will be properly imported when extension support is added
 */
type ChromeNotificationOptions = {
	type: 'basic' | 'image' | 'list' | 'progress';
	title: string;
	message: string;
	iconUrl: string;
	requireInteraction?: boolean;
	priority?: -2 | -1 | 0 | 1 | 2;
	buttons?: Array<{ title: string }>;
};

/**
 * Converts a nanoid string to a numeric ID for Tauri notifications.
 *
 * This function takes a nanoid (alphanumeric random string like "V1StGXR8_Z5jdHi6B-myT")
 * and converts it to a numeric hash. This is necessary because Tauri's notification
 * API requires numeric IDs, while we use nanoid strings for consistency with web APIs.
 *
 * Note: This is NOT parsing a stringified number - it's hashing an alphanumeric string.
 *
 * @param str - A nanoid string (e.g., "V1StGXR8_Z5jdHi6B-myT")
 * @returns A positive integer hash of the string
 */
export function hashNanoidToNumber(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash);
}
