import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const { BrowserServiceError, BrowserServiceErr } = createTaggedError(
	'BrowserServiceError',
);
type BrowserServiceError = ReturnType<typeof BrowserServiceError>;

export type BrowserService = {
	/**
	 * Open a URL in the default browser across platforms
	 */
	openUrl(url: string): Promise<Result<void, BrowserServiceError>>;
};
