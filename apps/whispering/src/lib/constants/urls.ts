/**
 * URL and pathname constants for the Whispering application
 */
const buildBase = import.meta.env.BASE_URL ?? '/';
export const WHISPERING_BASE_PATHNAME =
	buildBase === '/' ? '' : buildBase.replace(/\/$/, '');

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
