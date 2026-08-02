/**
 * Public OAuth client ids and scopes every Epicenter first-party app presents
 * during sign-in.
 *
 * These are public PKCE client ids, not secrets: each identifies an app type,
 * not a user, machine, install, or credential, and every install of a given
 * app uses the same value. They are split out from the server-only trusted
 * client builders (see oauth-seed.ts) so a framework-agnostic client like
 * `@epicenter/auth` can import an id and the scopes without reaching the seed
 * layer or its `@better-auth/oauth-provider` types.
 */

export const EPICENTER_DESKTOP_OAUTH_CLIENT_ID = 'epicenter-desktop';
export const EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI =
	'epicenter://auth/callback';
export const EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID = 'epicenter-honeycrisp';
export const EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI =
	'epicenter-honeycrisp://oauth/callback';
export const EPICENTER_WHISPERING_OAUTH_CLIENT_ID = 'epicenter-whispering';
export const EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID = 'epicenter-tab-manager';
export const EPICENTER_VOCAB_OAUTH_CLIENT_ID = 'epicenter-vocab';

export const EPICENTER_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
] as const;

export const EPICENTER_OAUTH_SCOPE = EPICENTER_OAUTH_SCOPES.join(' ');
