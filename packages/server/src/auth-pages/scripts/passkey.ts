import { raw } from 'hono/html';

/**
 * Vanilla WebAuthn ceremony for the server-rendered auth pages.
 *
 * These pages have no bundler, so this reimplements the small slice of
 * `@simplewebauthn/browser` the Better Auth passkey client would normally
 * provide: the base64url <-> ArrayBuffer conversions plus the two ceremonies,
 * driven directly against the plugin's REST endpoints (verified against
 * `@better-auth/passkey` 1.6.23):
 *
 *   authenticate: GET  /auth/passkey/generate-authenticate-options  (no session)
 *                 navigator.credentials.get()
 *                 POST /auth/passkey/verify-authentication  { response }
 *                 -> sets a standard session cookie; caller reloads so the
 *                    OAuth loginPage continues the authorize flow.
 *
 *   register:     GET  /auth/passkey/generate-register-options  (needs session)
 *                 navigator.credentials.create()
 *                 POST /auth/passkey/verify-registration  { response }
 *
 * The verify endpoints wrap the WebAuthn credential JSON under a `response`
 * key, so the credential (which itself has a nested `response`) is sent as
 * `{ response: <AuthenticationResponseJSON | RegistrationResponseJSON> }`.
 *
 * Exposes `window.epicenterPasskey = { supported, authenticate, register }`.
 * Each ceremony resolves `{ ok: true }` or `{ ok: false, error }` and never
 * throws, so callers stay simple.
 */
export const PASSKEY_SCRIPT = raw(`<script>
window.epicenterPasskey = (() => {
	const decode = (value) => {
		const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			'=',
		);
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes.buffer;
	};

	const encode = (buffer) => {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.length; i++)
			binary += String.fromCharCode(bytes[i]);
		return btoa(binary)
			.replace(/\\+/g, '-')
			.replace(/\\//g, '_')
			.replace(/=+$/, '');
	};

	const supported = () =>
		typeof window.PublicKeyCredential === 'function' &&
		!!(navigator.credentials && navigator.credentials.get);

	const cancelled = (err) => err && err.name === 'NotAllowedError';

	const authenticate = async () => {
		let options;
		try {
			const res = await fetch('/auth/passkey/generate-authenticate-options', {
				method: 'GET',
				credentials: 'include',
				headers: { Accept: 'application/json' },
			});
			if (!res.ok) return { ok: false, error: 'Could not start passkey sign-in.' };
			options = await res.json();
		} catch {
			return { ok: false, error: 'Network error starting passkey sign-in.' };
		}

		const publicKey = Object.assign({}, options, {
			challenge: decode(options.challenge),
			allowCredentials: (options.allowCredentials || []).map((cred) =>
				Object.assign({}, cred, { id: decode(cred.id) }),
			),
		});

		let credential;
		try {
			credential = await navigator.credentials.get({ publicKey });
		} catch (err) {
			return {
				ok: false,
				error: cancelled(err)
					? 'Passkey sign-in was cancelled.'
					: 'Passkey sign-in failed.',
			};
		}
		if (!credential) return { ok: false, error: 'No passkey was selected.' };

		const response = {
			id: credential.id,
			rawId: encode(credential.rawId),
			type: credential.type,
			authenticatorAttachment: credential.authenticatorAttachment || undefined,
			clientExtensionResults: credential.getClientExtensionResults
				? credential.getClientExtensionResults()
				: {},
			response: {
				authenticatorData: encode(credential.response.authenticatorData),
				clientDataJSON: encode(credential.response.clientDataJSON),
				signature: encode(credential.response.signature),
				userHandle: credential.response.userHandle
					? encode(credential.response.userHandle)
					: undefined,
			},
		};

		try {
			const res = await fetch('/auth/passkey/verify-authentication', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ response }),
			});
			if (!res.ok) return { ok: false, error: 'Passkey could not be verified.' };
		} catch {
			return { ok: false, error: 'Network error verifying passkey.' };
		}
		return { ok: true };
	};

	const register = async (name) => {
		let options;
		try {
			const query = name ? '?name=' + encodeURIComponent(name) : '';
			const res = await fetch('/auth/passkey/generate-register-options' + query, {
				method: 'GET',
				credentials: 'include',
				headers: { Accept: 'application/json' },
			});
			if (!res.ok)
				return { ok: false, error: 'Could not start passkey setup. Are you still signed in?' };
			options = await res.json();
		} catch {
			return { ok: false, error: 'Network error starting passkey setup.' };
		}

		const publicKey = Object.assign({}, options, {
			challenge: decode(options.challenge),
			user: Object.assign({}, options.user, { id: decode(options.user.id) }),
			excludeCredentials: (options.excludeCredentials || []).map((cred) =>
				Object.assign({}, cred, { id: decode(cred.id) }),
			),
		});

		let credential;
		try {
			credential = await navigator.credentials.create({ publicKey });
		} catch (err) {
			return {
				ok: false,
				error: cancelled(err)
					? 'Passkey setup was cancelled.'
					: 'Passkey setup failed.',
			};
		}
		if (!credential) return { ok: false, error: 'Passkey was not created.' };

		const response = {
			id: credential.id,
			rawId: encode(credential.rawId),
			type: credential.type,
			authenticatorAttachment: credential.authenticatorAttachment || undefined,
			clientExtensionResults: credential.getClientExtensionResults
				? credential.getClientExtensionResults()
				: {},
			response: {
				attestationObject: encode(credential.response.attestationObject),
				clientDataJSON: encode(credential.response.clientDataJSON),
				transports: credential.response.getTransports
					? credential.response.getTransports()
					: undefined,
			},
		};

		try {
			const res = await fetch('/auth/passkey/verify-registration', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ response }),
			});
			if (!res.ok) return { ok: false, error: 'Passkey could not be saved.' };
		} catch {
			return { ok: false, error: 'Network error saving passkey.' };
		}
		return { ok: true };
	};

	return { supported, authenticate, register };
})();
</script>`);
