/**
 * URL and pathname constants for the Whispering application
 */
import { WHISPERING_BASE_PATHNAME } from '#platform/base-path';

export { WHISPERING_BASE_PATHNAME };

export function whisperingPath(pathname: '/' | `/${string}`): string {
	return pathname === '/'
		? `${WHISPERING_BASE_PATHNAME}/`
		: `${WHISPERING_BASE_PATHNAME}${pathname}`;
}

export function normalizeWhisperingPath(pathname: string): string {
	if (
		pathname === WHISPERING_BASE_PATHNAME ||
		pathname.startsWith(`${WHISPERING_BASE_PATHNAME}/`)
	) {
		return pathname;
	}
	return whisperingPath(
		pathname.startsWith('/') ? (pathname as `/${string}`) : `/${pathname}`,
	);
}

export const WHISPERING_RECORDINGS_PATHNAME = whisperingPath('/recordings');
