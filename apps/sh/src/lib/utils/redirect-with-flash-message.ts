import { APPS } from '@repo/constants/vite';
import { type } from 'arktype';
import { goto } from '$app/navigation';

/**
 * Unified redirect API with flash message support.
 *
 * Provides a consistent interface for redirecting to different parts of the application
 * with user-friendly flash messages. All redirect methods return `never` and should be
 * followed by a `return` statement for explicit control flow.
 *
 * @example
 * ```typescript
 * import { redirectTo } from '$lib/utils/redirects';
 *
 * // In a load function or server action
 * if (!authorized) {
 *   redirectTo.homepage.error({
 *     title: 'Access Denied',
 *     description: 'You do not have permission to view this resource'
 *   });
 *   return;
 * }
 * ```
 */
export const redirectTo = {
	/**
	 * Creates redirect methods for a specific assistant
	 * @param assistantId - The ID of the assistant to redirect to
	 * @returns An object with redirect methods for different message types
	 * @example
	 * ```typescript
	 * // Chained method pattern
	 * if (sessionError) {
	 *   redirectTo.assistant(params.id).error(sessionError);
	 *   return;
	 * }
	 *
	 * // With custom message
	 * if (!session) {
	 *   redirectTo.assistant(params.id).info({
	 *     title: 'Session Not Found',
	 *     description: 'The requested session does not exist'
	 *   });
	 *   return;
	 * }
	 * ```
	 */
	assistant: (assistantId: string) =>
		createRedirectMethods(`/assistants/${assistantId}` as const),

	/**
	 * Assistants list redirect methods with flash message support
	 * @example
	 * ```typescript
	 * if (!assistantConfig) {
	 *   redirectTo.assistants.error({
	 *     title: 'Assistant Not Found',
	 *     description: 'The assistant you requested does not exist'
	 *   });
	 *   return;
	 * }
	 * ```
	 */
	assistants: createRedirectMethods('/assistants' as const),

	/**
	 * Homepage redirect methods with flash message support
	 * @example
	 * ```typescript
	 * if (!authorized) {
	 *   redirectTo.homepage.error({
	 *     title: 'Access Denied',
	 *     description: 'You do not have permission to view this page'
	 *   });
	 *   return;
	 * }
	 * ```
	 */
	homepage: createRedirectMethods('/' as const),
} as const;

/**
 * Flash message schema for validation
 */
export const FlashMessage = type({
	title: 'string',
	description: 'string',
	type: "'error' | 'success' | 'info' | 'warning'",
});

type FlashMessage = typeof FlashMessage.infer;

/**
 * URL parameter names for flash messages
 */
export const FLASH_MESSAGE_PARAMS = {
	title: 'flash_title',
	description: 'flash_description',
	type: 'flash_type',
} as const;

/**
 * Creates an object with error, info, success, and warning redirect methods
 * @internal
 */
function createRedirectMethods(location: `/${string}`) {
	return {
		/**
		 * Redirect with an error message
		 * @param message - The error message to display
		 * @returns Never - this function always throws a redirect
		 */
		error(message: Omit<FlashMessage, 'type'>) {
			console.log('🚀 ~ location:', location);
			return redirectWithFlash(location, { ...message, type: 'error' });
		},

		/**
		 * Redirect with an informational message
		 * @param message - The info message to display
		 * @returns Never - this function always throws a redirect
		 */
		info(message: Omit<FlashMessage, 'type'>) {
			return redirectWithFlash(location, { ...message, type: 'info' });
		},

		/**
		 * Redirect with a success message
		 * @param message - The success message to display
		 * @returns Never - this function always throws a redirect
		 */
		success(message: Omit<FlashMessage, 'type'>) {
			return redirectWithFlash(location, { ...message, type: 'success' });
		},

		/**
		 * Redirect with a warning message
		 * @param message - The warning message to display
		 * @returns Never - this function always throws a redirect
		 */
		warning(message: Omit<FlashMessage, 'type'>) {
			return redirectWithFlash(location, { ...message, type: 'warning' });
		},
	};
}

/**
 * Internal helper that wraps SvelteKit's redirect with flash message support
 * @internal
 */
function redirectWithFlash(location: `/${string}`, message: FlashMessage) {
	const url = new URL(location, APPS.SH.URL);
	url.searchParams.set(FLASH_MESSAGE_PARAMS.title, message.title);
	url.searchParams.set(FLASH_MESSAGE_PARAMS.description, message.description);
	url.searchParams.set(FLASH_MESSAGE_PARAMS.type, message.type);
	return goto(url.pathname + url.search);
}
