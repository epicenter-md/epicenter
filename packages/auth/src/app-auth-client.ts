import type { Logger } from 'wellcrafted/logger';
import type { AuthClient, AuthFetch } from './auth-contract.js';
import { createOAuthAppAuth } from './create-oauth-app-auth.js';
import type { Instance } from './instance.js';
import { createInstanceTokenAuth } from './instance-token-auth.js';
import type { OAuthLauncher } from './oauth-launchers/contract.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';

/**
 * The OAuth half's construction inputs: everything the hosted PKCE client needs
 * and the self-host token client does not. They are always supplied because the
 * branch is the runtime instance, not a build-time choice; the token branch
 * simply ignores them.
 */
export type CreateAppAuthClientOptions = {
	/** Public OAuth client id for this app (used only by the hosted OAuth branch). */
	clientId: string;
	/** Durable storage for the OAuth persisted auth cell. */
	persistedAuthStorage: PersistedAuthStorage;
	/**
	 * Hosted-only OAuth launcher. Built once from the app's hosted constants
	 * (issuer, resource, redirect), never from the instance base URL: OAuth runs
	 * only against the hosted star (ADR-0071).
	 */
	launcher: OAuthLauncher;
	/** Fetch for session verification, refresh, revoke, and resource calls. */
	fetch?: AuthFetch;
	/** WebSocket constructor (tests and non-browser runtimes inject it). */
	WebSocket?: typeof WebSocket;
	/** Clock for OAuth refresh-skew checks. */
	now?: () => number;
	/** Library logger for subscriber and refresh failures. */
	log?: Logger;
};

/**
 * The one choke point that turns a persisted {@link Instance} into a concrete
 * auth client. Every Epicenter surface reaches auth through here.
 *
 * The persisted instance is the only branch, and it is a clean two-state value
 * (ADR-0070/0071):
 *
 * - A `token` means a self-hosted star: authenticate with the static bearer the
 *   box minted ({@link createInstanceTokenAuth}); no OAuth flow, launcher, or
 *   persisted grant.
 * - No `token` means the hosted default: run OAuth ({@link createOAuthAppAuth})
 *   against the hosted star with the app's hosted-constant launcher. The
 *   {@link InstanceSetting} guarantees a no-token instance carries the hosted
 *   base URL, so OAuth never targets a self-hosted origin.
 *
 * Both branches carry a bearer, so both can actually open the sync socket
 * {@link AuthClient.openWebSocket} promises, and the result is a drop-in for
 * principal-scoped sync regardless of which credential model was chosen. There
 * is no persisted mode tag: the credential model is recomputed from the
 * instance at construction, not stored as a discriminator. Downstream callers
 * receive one connection shape and do not need to know which credential branch
 * produced it.
 */
export function createAppAuthClient(
	instance: Instance,
	{
		clientId,
		persistedAuthStorage,
		launcher,
		fetch,
		WebSocket,
		now,
		log,
	}: CreateAppAuthClientOptions,
): AuthClient {
	if (instance.token) {
		return createInstanceTokenAuth({
			baseURL: instance.baseURL,
			token: instance.token,
			fetch,
			WebSocket,
			log,
		});
	}
	return createOAuthAppAuth({
		baseURL: instance.baseURL,
		clientId,
		persistedAuthStorage,
		launcher,
		fetch,
		WebSocket,
		now,
		log,
	});
}
