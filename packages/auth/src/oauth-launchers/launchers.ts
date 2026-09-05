import { Ok } from 'wellcrafted/result';
import type {
	CallbackOAuthLauncher,
	OAuthLauncher,
	OAuthLaunchResult,
} from './contract.js';
import {
	createOAuthClient,
	type MaybePromise,
	type OAuthClientConfig,
	OAuthClientError,
} from './oauth-client.js';

/**
 * Create the browser redirect launcher for hosted sign-in.
 *
 * Use this in web apps that complete OAuth by returning to their own redirect
 * URI. The two halves of that round trip are two methods, and they used to be
 * one: `startSignIn` inspected the current URL and exchanged an authorization
 * code when it found one, so the same call finished a sign-in on the callback
 * route and began one everywhere else, chosen by a query string. The callback
 * route consequently asked to START a sign-in in order to finish one, which
 * reads as a bug even when it works, and which really is one the moment a
 * person lands on the callback URL with no code: the launcher mints a fresh
 * PKCE transaction and redirects, from a route whose whole job was to consume
 * the previous one.
 *
 * `redirectTo` and the current URL both come from `window` by default. Tests
 * substitute the redirect through the option and the URL by standing up a
 * `globalThis.window`, which is what the launcher genuinely reads.
 */
export function createBrowserOAuthLauncher({
	redirectTo = (url) => {
		window.location.href = url;
	},
	redirectUri,
	...config
}: OAuthClientConfig & {
	redirectUri: string;
	redirectTo?: (url: string) => MaybePromise<void>;
}) {
	const client = createOAuthClient(config);
	return {
		async startSignIn() {
			const urlResult = await client.createAuthorizationUrl(redirectUri);
			if (urlResult.error) return urlResult;
			await redirectTo(urlResult.data.toString());
			return Ok({ status: 'launched' } satisfies OAuthLaunchResult);
		},
		completeSignIn() {
			return client.exchangeCallback(window.location.href);
		},
	} satisfies CallbackOAuthLauncher;
}

/**
 * Create the extension launcher around the browser extension web-auth API.
 *
 * Use this when the runtime can open the hosted authorization URL and return
 * the final redirect URL without navigating the extension UI. It keeps the same
 * PKCE/state transaction as the browser launcher, but the token grant is
 * returned directly so the extension can persist it without relying on page
 * reloads.
 */
export function createExtensionOAuthLauncher({
	launchWebAuthFlow,
	redirectUri,
	...config
}: OAuthClientConfig & {
	redirectUri: string;
	launchWebAuthFlow: (url: string) => Promise<string>;
}) {
	const client = createOAuthClient(config);
	return {
		async startSignIn() {
			const urlResult = await client.createAuthorizationUrl(redirectUri);
			if (urlResult.error) return urlResult;

			try {
				const responseUrl = await launchWebAuthFlow(urlResult.data.toString());
				const callbackResult = await client.exchangeCallback(responseUrl);
				if (callbackResult.error) return callbackResult;
				return Ok({
					status: 'completed',
					grant: callbackResult.data,
				} satisfies OAuthLaunchResult);
			} catch (cause) {
				return OAuthClientError.LaunchFailed({ cause });
			}
		},
	} satisfies OAuthLauncher;
}
