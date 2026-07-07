/**
 * Response shape of `GET /sign-in/context`, the sign-in surface's JSON
 * bootstrap, owned by `packages/server/src/routes/auth.ts`.
 *
 * Mirrored here rather than imported: the contract is one small JSON shape
 * across an HTTP boundary, and pulling `@epicenter/server` into the SPA's
 * typecheck for it would cost more than the duplication. Keep the two in sync
 * by hand; the server's route tests pin the wire shape.
 *
 * `providers` carries the deployment's enablement truth (register-when-present
 * OAuth credentials). A provider absent from the backend never reaches this
 * object, so the UI cannot render a dead button; passkey support lands as a
 * new key here once a WebAuthn backend exists.
 */
export type SocialProvider = 'google' | 'github' | 'microsoft' | 'apple';

export type SignInContext = {
	providers: Record<SocialProvider, boolean>;
	passkeyEnabled: boolean;
	session: { name: string; email: string } | null;
};

export const SOCIAL_PROVIDERS = [
	'google',
	'github',
	'microsoft',
	'apple',
] as const satisfies readonly SocialProvider[];

export const PROVIDER_LABELS: Record<SocialProvider, string> = {
	google: 'Google',
	github: 'GitHub',
	microsoft: 'Microsoft',
	apple: 'Apple',
};
