export {
	type CreateAppAuthClientOptions,
	createAppAuthClient,
} from './app-auth-client.js';
export type {
	AuthClient,
	AuthFetch,
	AuthState,
	Connection,
	ConnectionStatus,
} from './auth-contract.js';
export * from './auth-errors.js';
export {
	ApiSessionResponse,
	Principal,
} from './auth-types.js';
export {
	type AuthFetchInput,
	fetchWithBearer,
	resolveTargetUrl,
} from './bearer-fetch.js';
export {
	type Instance,
	InstanceUrlError,
	normalizeInstanceUrl,
} from './instance.js';
export {
	createInstanceCredentialAuthority,
	type InstanceCredentialAuthority,
} from './instance-credential-authority.js';
export {
	createInstanceSetting,
	type InstanceSetting,
	loadInstanceSetting,
} from './instance-setting.js';
// The pure pieces of the single-partition instance bearer (self-host; ADR-0075):
// `generateInstanceToken` mints a strong token (`gen-token`), `assertStrongToken`
// is the boot entropy gate. They live here (not `@epicenter/server`) so a token
// can be generated and validated without the server graph. The resolver side
// (`createEnvTokenResolver`) stays in `@epicenter/server`.
export {
	assertStrongToken,
	generateInstanceToken,
	MIN_INSTANCE_TOKEN_CHARS,
} from './instance-token.js';
export {
	createOAuthCredentialAuthority,
	type OAuthCredentialAuthority,
} from './oauth-credential-authority.js';
export {
	createSerializedPersistedAuthStorage,
	createWebStoragePersistedAuthStorage,
	loadPersistedAuthStorage,
	type PersistedAuthStorage,
} from './persisted-auth-storage.js';
export { getProfileVia } from './read-api-session.js';
export {
	type CreateSameOriginCookieAuthConfig,
	createSameOriginCookieAuth,
} from './same-origin-cookie-auth.js';
