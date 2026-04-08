import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type AuthSession,
	readStatusCode,
	type StoredUser,
} from './auth-types.js';

type BaseURL = string | (() => string);

export const AuthError = defineErrors({
	InvalidCredentials: () => ({
		message: 'Invalid email or password.',
	}),
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SocialSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Social sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

export type AuthClient = {
	/**
	 * Whether the user is currently authenticated.
	 * Convenience getter so consumers don't null-check the session
	 * in every component.
	 *
	 * @example
	 * ```svelte
	 * {#if auth.isAuthenticated}
	 *   <p>Welcome back, {auth.user?.name}!</p>
	 * {:else}
	 *   <AuthForm />
	 * {/if}
	 * ```
	 */
	isAuthenticated: boolean;

	/**
	 * The current user, or `null` if not authenticated.
	 *
	 * Narrows the nullable session store once at the source so every
	 * consumer doesn't repeat the same null-check pattern.
	 *
	 * @example
	 * ```svelte
	 * {#if auth.user}
	 *   <p>{auth.user.name} — {auth.user.email}</p>
	 * {/if}
	 * ```
	 */
	user: StoredUser | null;

	/**
	 * The current session token, or `null` if not authenticated.
	 *
	 * Same narrowing as `user`—extracts the token from the authenticated
	 * session so consumers don't repeat the `session ? session.token : null`
	 * ternary in every `getToken` callback.
	 *
	 * @example
	 * ```typescript
	 * createSyncExtension({
	 *   getToken: async () => auth.token,
	 * })
	 * ```
	 */
	token: string | null;
	/**
	 * Whether a user-initiated auth operation (sign-in, sign-up, sign-out) is
	 * in progress. Toggles on and off with each auth operation. Use it to
	 * disable buttons and show spinners during auth flows.
	 *
	 * @example
	 * ```svelte
	 * <Button disabled={auth.isBusy}>
	 *   {#if auth.isBusy}
	 *     <Spinner />
	 *   {:else}
	 *     Sign in
	 *   {/if}
	 * </Button>
	 * ```
	 */
	isBusy: boolean;

	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	/**
	 * Sign in using the injected `socialTokenProvider`.
	 *
	 * Orchestrates the full popup/native flow: acquires the token from the
	 * platform-specific provider, sends it to BA, and handles errors—keeping
	 * UI components free of auth orchestration logic.
	 *
	 * Only available when `socialTokenProvider` was passed to `createAuth`.
	 * Returns `SocialSignInFailed` if no provider was configured.
	 *
	 * @example
	 * ```svelte
	 * <Button onclick={async () => {
	 *   const { error } = await auth.signInWithSocialPopup();
	 *   if (error) submitError = error.message;
	 * }}>
	 *   Continue with Google
	 * </Button>
	 * ```
	 */
	signInWithSocialPopup(): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<void>;
	/**
	 * Redirect-based social sign-in for web apps. Navigates away from the
	 * current page on success. Returns a `Result` so pre-navigation errors
	 * (network failures, misconfigured providers) are handled consistently
	 * with other auth methods.
	 *
	 * Works for ALL social providers (Google, GitHub, Apple, etc.).
	 * This is the only sign-in path for providers like GitHub that don't
	 * support ID token verification.
	 *
	 * @example
	 * ```typescript
	 * const { error } = await auth.signInWithSocialRedirect({
	 *   provider: 'google',
	 *   callbackURL: '/',
	 * });
	 * if (error) submitError = error.message;
	 * ```
	 */
	signInWithSocialRedirect(options: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;

	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type CreateAuthOptions = {
	baseURL: BaseURL;
	session: {
		current: AuthSession | null;
		/** Authoritative read. Sync for localStorage, async for chrome.storage. */
		get(): AuthSession | null | Promise<AuthSession | null>;
	};
	/**
	 * Called whenever the session is authenticated—construction (if a cached
	 * session exists in the store), sign-in, session restore, or token refresh.
	 *
	 * Fires at construction time if a cached session exists in the store,
	 * then on every authenticated session update from Better Auth.
	 * Consumers should use idempotent operations (e.g. `applyEncryptionKeys` is safe
	 * to call repeatedly with the same keys).
	 *
	 * @example
	 * ```typescript
	 * onLogin(session) {
	 *   workspace.applyEncryptionKeys(session.encryptionKeys);
	 *   workspace.extensions.sync.reconnect();
	 * }
	 * ```
	 */
	onLogin?: (session: AuthSession) => void;
	/**
	 * Called on the authenticated → anonymous transition only.
	 *
	 * NOT called on cold start when no prior session exists—only when a
	 * previously authenticated session ends (explicit sign-out or server
	 * revocation). Use this to clear local data and disconnect sync.
	 *
	 * @example
	 * ```typescript
	 * onLogout() {
	 *   workspace.clearLocalData();
	 *   workspace.extensions.sync.reconnect();
	 * }
	 * ```
	 */
	onLogout?: () => void;
	/**
	 * Platform-specific credential provider for social ID token sign-in.
	 *
	 * Injected at creation time so the auth client can orchestrate the full
	 * popup flow (acquire token → send to BA → handle errors) without pushing
	 * platform logic into UI components. Only needed for native/popup flows—
	 * web apps using redirect sign-in don't need this.
	 *
	 * The returned `provider` identifies which BA social provider to verify
	 * the token against (e.g. `'google'`, `'apple'`).
	 *
	 * @example
	 * ```typescript
	 * createAuth({
	 *   socialTokenProvider: async () => {
	 *     const { idToken, nonce } = await getGoogleCredentials();
	 *     return { provider: 'google', idToken, nonce };
	 *   },
	 * });
	 * ```
	 */
	socialTokenProvider?: () => Promise<{
		provider: string;
		idToken: string;
		nonce: string;
	}>;
};
/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * The canonical pattern is `customSessionClient<typeof auth>()`, but `typeof auth`
 * drags in server-only types that client packages in a monorepo cannot resolve.
 * `InferPlugin<T>()` is a first-party export from `better-auth/client` that sets
 * the same `$InferServerPlugin` property without requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<SessionResponse, BetterAuthOptions>
>;

/**
 * Create a single auth client that owns transport and session lifecycle.
 *
 * BA's `useSession.subscribe()` drives reactive state—writes to the `$state`-backed
 * session box so getters are reactive without additional subscription wiring.
 * Methods return errors only—subscribe handles the success path.
 * `session.current` is the source of truth. This module only reads/writes the
 * box and does not own persistence.
 */
export function createAuth({
	baseURL,
	session,
	onLogin,
	onLogout,
	socialTokenProvider,
}: CreateAuthOptions): AuthClient {
	/**
	 * Tracks whether a user-initiated auth command is in flight.
	 * Toggled by every command method (signIn, signUp, signOut, signInWithSocialPopup)
	 * via try/finally so it always resets—even on errors.
	 */
	let isBusy = $state(false);

	/**
	 * Internal Better Auth client. All BA-specific API calls go through this.
	 * Configured with bearer auth from the persisted session box and a
	 * token-rotation interceptor so the local copy stays fresh.
	 */
	const client = createAuthClient({
		baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => session.current?.token,
			},
			// BA silently rotates tokens on authenticated requests. The new
			// token arrives in a response header rather than through the
			// useSession subscription, so we intercept it here and write it
			// to the persisted session box—otherwise the local copy goes
			// stale and subsequent requests use an expired token.
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (newToken && session.current !== null) {
					session.current = { ...session.current, token: newToken };
				}
			},
		},
	});

	client.useSession.subscribe((state) => {
		if (state.isPending) return;

		const prev = session.current;

		if (state.data) {
			const user = normalizeUser(state.data.user);
			const token = state.data.session.token;
			const authenticated = {
				token,
				user,
				encryptionKeys: state.data.encryptionKeys,
			};
			session.current = authenticated;
			onLogin?.(authenticated);
		} else {
			session.current = null;
			if (prev !== null) {
				onLogout?.();
			}
		}
	});

	// Boot: fire onLogin from the cached session so encryption keys are
	// applied before the BA subscription's server roundtrip resolves.
	// session.get() is sync for localStorage, async for chrome.storage.
	const boot = session.get();
	const applyBoot = (cached: AuthSession | null) => {
		if (cached) onLogin?.(cached);
	};
	if (boot instanceof Promise) {
		void boot.then(applyBoot);
	} else {
		applyBoot(boot);
	}

	return {
		get isAuthenticated() {
			return session.current !== null;
		},

		get user() {
			return session.current?.user ?? null;
		},

		get token() {
			return session.current?.token ?? null;
		},

		get isBusy() {
			return isBusy;
		},

		async signIn(input) {
			isBusy = true;
			try {
				const { error } = await client.signIn.email(input);
				if (!error) return Ok(undefined);
				const status = readStatusCode(error);
				if (status === 401 || status === 403)
					return AuthError.InvalidCredentials();
				return AuthError.SignInFailed({ cause: error });
			} catch (error) {
				return AuthError.SignInFailed({ cause: error });
			} finally {
				isBusy = false;
			}
		},

		async signUp(input) {
			isBusy = true;
			try {
				const { error } = await client.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			} finally {
				isBusy = false;
			}
		},

		async signInWithSocialPopup() {
			if (!socialTokenProvider) {
				return AuthError.SocialSignInFailed({
					cause: new Error('No socialTokenProvider configured.'),
				});
			}

			isBusy = true;
			try {
				const { provider, idToken, nonce } = await socialTokenProvider();
				const { error } = await client.signIn.social({
					provider,
					idToken: { token: idToken, nonce },
				});
				if (error) return AuthError.SocialSignInFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			} finally {
				isBusy = false;
			}
		},

		async signOut() {
			isBusy = true;
			try {
				await client.signOut();
			} catch (error) {
				console.error('[auth] sign-out failed:', error);
			} finally {
				isBusy = false;
			}
		},

		async signInWithSocialRedirect({ provider, callbackURL }) {
			try {
				await client.signIn.social({ provider, callbackURL });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		fetch(input: RequestInfo | URL, init?: RequestInit) {
			const headers = new Headers(init?.headers);
			const token = session.current?.token;
			if (token) headers.set('Authorization', `Bearer ${token}`);
			return fetch(input, { ...init, headers, credentials: 'include' });
		},
	};
}

/**
 * Convert BA's `Date` fields to ISO strings for JSON-safe persistence.
 *
 * BA returns `createdAt` and `updatedAt` as `Date` objects. The persisted
 * session box (chrome.storage, localStorage) needs plain JSON, so we
 * normalize here at the boundary rather than forcing every consumer to handle it.
 */
function normalizeUser(user: {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	email: string;
	emailVerified: boolean;
	name: string;
	image?: string | null;
}): StoredUser {
	return {
		id: user.id,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
		email: user.email,
		emailVerified: user.emailVerified,
		name: user.name,
		image: user.image,
	};
}
