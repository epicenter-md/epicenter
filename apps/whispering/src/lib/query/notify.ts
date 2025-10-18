import { Ok } from 'wellcrafted/result';
import { dev } from '$app/environment';
import { notificationLog } from '$lib/components/NotificationLog.svelte';
import * as services from '$lib/services';
import type { UnifiedNotificationOptions } from '$lib/services/notifications/types';
import { defineMutation } from './_client';

// Create a mutation for a specific variant
const createNotifyMutation = (
	variant: NonNullable<UnifiedNotificationOptions['variant']>,
) =>
	defineMutation({
		mutationKey: ['notify', variant],
		resultMutationFn: async (
			options: Omit<UnifiedNotificationOptions, 'variant'>,
		) => {
			const fullOptions: UnifiedNotificationOptions = { ...options, variant };

			// Log in dev mode
			if (dev) {
				switch (variant) {
					case 'error':
						console.error('[Notify]', fullOptions);
						break;
					case 'warning':
						console.warn('[Notify]', fullOptions);
						break;
					case 'info':
						console.info('[Notify]', fullOptions);
						break;
					case 'loading':
						console.info('[Notify]', fullOptions);
						break;
					case 'success':
						console.log('[Notify]', fullOptions);
						break;
				}
			}

			// Add to notification log
			notificationLog.addLog(fullOptions);

			// Always show toast
			const toastId = services.toast.show(fullOptions);

			// Also show OS notification (system notifications or browser/extension notifications)
			// We exclude 'loading' notifications because:
			// 1. OS notifications don't support updating/replacing notifications with the same ID
			//    (unlike Sonner toasts which can update in-place)
			// 2. Loading states are temporary and would create notification spam
			if (variant !== 'loading') {
				const { error: notifyError } =
					await services.notification.notify(fullOptions);
				if (notifyError) {
					console.error('[Notify] OS notification error:', notifyError);
				}
			}

			return Ok(toastId);
		},
	});

/**
 * Notification Query Layer
 *
 * The `notify` API provides a unified interface for showing notifications to users,
 * coordinating between two distinct notification systems:
 *
 * 1. **Toast notifications** (in-app) - Temporary UI notifications using Sonner
 * 2. **OS notifications** (system-level) - Native desktop/browser notifications
 *
 * ## Architecture Distinction
 *
 * - **`notifications` service** (service layer): Low-level service that handles
 *   platform-specific OS notification APIs (Tauri desktop notifications, browser
 *   Notification API, future Chrome extension API)
 *
 * - **`notify` API** (query layer): High-level abstraction that ensures users get
 *   both visual feedback (toast) AND persistent system alerts (OS notification)
 *   with a single call
 *
 * ## Why Both?
 *
 * - **Toasts**: Immediate visual feedback within the app, supports actions and updates
 * - **OS Notifications**: Persist in system tray, work when app is minimized/unfocused
 *
 * ## Usage
 *
 * ```typescript
 * // Simple notification - shows both toast and OS notification
 * await notify.success.execute({
 *   title: 'Recording saved',
 *   description: 'Your recording has been transcribed'
 * });
 *
 * // Loading notification - only shows toast (no OS notification spam)
 * const loadingId = await notify.loading.execute({
 *   title: 'Processing...',
 *   description: 'This may take a moment'
 * });
 *
 * // Later, dismiss the loading toast
 * notify.dismiss(loadingId);
 * ```
 *
 * ## Special Behavior
 *
 * - **Loading notifications**: Only show as toasts, not OS notifications, because:
 *   - OS notifications can't be updated/replaced with the same ID
 *   - Loading states are temporary and would create notification spam
 *   - Toasts can be updated in-place using the same ID
 *
 * - **Dev logging**: In development mode, notifications are logged to console
 *   with appropriate log levels (error, warn, info, etc.)
 *
 * - **Notification log**: All notifications are stored in a log for debugging
 *   and user history via `notificationLog.addLog()`
 */
// Export the notify API
export const notify = {
	// Variant-specific methods
	success: createNotifyMutation('success'),
	error: createNotifyMutation('error'),
	warning: createNotifyMutation('warning'),
	info: createNotifyMutation('info'),
	loading: createNotifyMutation('loading'),

	// Dismiss method
	dismiss: (id?: string | number) => services.toast.dismiss(id),
};
