import {
	createHttpBinding,
	type EpicenterBinding,
} from './index.js';

/** Desktop binding: the Bun sidecar is the owner reached through same-origin HTTP. */
export function createDesktopBinding(options: {
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
	appId?: string;
} = {}): EpicenterBinding {
	if (options.appId === undefined) {
		throw new Error('The desktop binding needs the scoped application id.');
	}
	return createHttpBinding({
		appId: options.appId,
		baseURL: options.baseURL,
		fetch: options.fetch,
	});
}
