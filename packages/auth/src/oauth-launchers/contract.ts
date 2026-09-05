import type { Result } from 'wellcrafted/result';
import type { OAuthTokenGrant } from '../auth-types.js';

/**
 * Result of a runtime-specific OAuth launch.
 *
 * `completed` means the launcher already has an authorization-code grant for
 * auth core to verify and persist. `launched` means the runtime handed control
 * away, usually through browser navigation, and completion will happen through
 * a later callback invocation.
 */
export type OAuthLaunchResult =
	| { status: 'completed'; grant: OAuthTokenGrant }
	| { status: 'launched' };

/**
 * Runtime-specific OAuth launcher consumed by auth core.
 *
 * A launcher owns the transport mechanics of sign-in: full-page browser
 * redirects, extension web-auth APIs, native-app deep links, or other runtimes.
 * `completed` carries the token grant immediately. `launched` means control has
 * moved to another runtime surface and a later callback will complete sign-in.
 */
export type OAuthLauncher = {
	startSignIn(): Promise<Result<OAuthLaunchResult, unknown>>;
};

/**
 * A launcher whose runtime comes back to a redirect URI it has to consume.
 *
 * The browser redirect launcher is one; the extension launcher is not, because
 * its web-auth flow hands the response URL straight back and completes inside
 * `startSignIn`. Auth core exposes `completeSignIn` on the client exactly when
 * the launcher it was composed with is one of these.
 */
export type CallbackOAuthLauncher = OAuthLauncher & {
	/**
	 * Exchange the callback this runtime is currently sitting on for a grant.
	 *
	 * It resolves a grant rather than an `OAuthLaunchResult`: a completion has
	 * no `launched` arm, and offering one would let a launcher answer "control
	 * moved elsewhere" to the call that exists to say it came back.
	 */
	completeSignIn(): Promise<Result<OAuthTokenGrant, unknown>>;
};
