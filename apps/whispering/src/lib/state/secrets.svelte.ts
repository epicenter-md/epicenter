import { deviceConfig, type SecretKey } from './device-config.svelte';

/**
 * `SecretKey` is the secret set the facade reads; re-exported for its callers
 * so they import the key type and the reader from one place.
 */
export type { SecretKey };

/**
 * The outcome of reading a secret (ADR-0074 invariant 5). `available` carries a
 * non-empty value; `missing` means no usable value is stored. An unset key reads
 * as `missing`, because an empty string is not a usable credential, so a caller
 * branches on status and never hands a provider SDK a blank key.
 *
 * There is no `locked` state. A server-derived keyring (invariant 1) arrives with
 * the authenticated session, so a present key is always decryptable; `locked`
 * would return only if the deferred passphrase seam were ever built.
 */
export type SecretRead =
	| { status: 'available'; value: string }
	| { status: 'missing' };

/**
 * The credential facade: the one place the app reads and writes provider secrets,
 * the values a user *brings* (ADR-0074). Every consumer reads through the
 * `available | missing` contract instead of pulling a raw string off
 * `deviceConfig`, so a blank key can never reach a provider SDK.
 *
 * ## Today: device-local plaintext, the safe degenerate
 *
 * Whispering has no auth yet, and the server-derived keyring (invariant 1)
 * arrives only with an authenticated session. With no session there is no
 * keyring, so secrets live device-local in plaintext `localStorage` through
 * `deviceConfig`. This is the deliberate degenerate the spec's staged plan calls
 * layer 1 (shared local read, no crypto), not a gap.
 *
 * ## The auth seam: the user-global encrypted vault
 *
 * When auth lands, the session delivers a server-derived per-owner keyring
 * (`HKDF(rootSecret, principalId)`; the deriving package is not built yet).
 * The facade then attaches ONE user-global vault Y.Doc, addressed by an
 * app-agnostic guid (`epicenter:secret-vault`, never a per-app one) so every
 * Epicenter app attaches the same doc and the same owner's key is the same key
 * regardless of which app reads it (invariant 3). It drives that doc through
 * `createEncryptedYkvLww`, calls `activateEncryption(keyring)`, and migrates the
 * device secrets into it. The read contract does not change: a synced key still
 * reads `available | missing`, because the authenticated keyring makes a present
 * key always decryptable. That wave owns the guid constant, the
 * localStorage-to-vault migration, and the relay attachment; the encrypted-KV
 * primitive and the keyring it needs already exist and are tested.
 */
export function createSecrets() {
	return {
		/**
		 * Read a secret reactively: it reads through `deviceConfig`, whose runes
		 * track the dependency, so a `$derived` re-runs when the value changes. An
		 * unset or empty key reads as `missing`.
		 */
		get(key: SecretKey): SecretRead {
			const value = deviceConfig.get(key);
			return value ? { status: 'available', value } : { status: 'missing' };
		},

		/** Write a secret to its home: device-local today, the encrypted vault when auth lands. */
		set(key: SecretKey, value: string): void {
			deviceConfig.set(key, value);
		},
	};
}

/** The Whispering secrets singleton. Device-only until auth lands (see above). */
export const secrets = createSecrets();
