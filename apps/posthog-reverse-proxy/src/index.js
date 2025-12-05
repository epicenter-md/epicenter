const API_HOST = 'us.i.posthog.com'; // Change to "eu.i.posthog.com" for the EU region
const ASSET_HOST = 'us-assets.i.posthog.com'; // Change to "eu-assets.i.posthog.com" for the EU region

async function forwardRequest(request, pathWithSearch) {
	const originRequest = new Request(request);
	originRequest.headers.delete('cookie');
	return await fetch(`https://${API_HOST}${pathWithSearch}`, originRequest);
}

async function handleRequest(request, ctx) {
	const url = new URL(request.url);
	const pathname = url.pathname;
	const search = url.search;
	const pathWithParams = pathname + search;

	if (pathname.startsWith('/static/')) {
		return retrieveStatic(request, pathWithParams, ctx);
	}
	return forwardRequest(request, pathWithParams);
}

async function retrieveStatic(request, pathname, ctx) {
	let response = await caches.default.match(request);
	if (!response) {
		response = await fetch(`https://${ASSET_HOST}${pathname}`);
		ctx.waitUntil(caches.default.put(request, response.clone()));
	}
	return response;
}

export default {
	async fetch(request, _env, ctx) {
		return handleRequest(request, ctx);
	},
};
