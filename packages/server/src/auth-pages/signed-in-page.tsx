/** @jsxImportSource hono/jsx */

import { raw } from 'hono/html';
import { PASSKEY_SCRIPT } from './scripts/passkey';

/**
 * Green checkmark circle SVG for the signed-in success state.
 * Rendered as raw HTML to avoid JSX SVG attribute noise.
 */
const CHECK_ICON =
	raw(`<svg class="success-icon" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
	<circle cx="24" cy="24" r="24" fill="oklch(0.962 0.044 156.743)"/>
	<path d="M15 24.5L21 30.5L33 18.5" stroke="oklch(0.448 0.119 151.328)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

/**
 * Passkey / fingerprint mark. Inherits the button text color via `currentColor`.
 */
const PASSKEY_ICON =
	raw(`<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
	<circle cx="10" cy="8" r="4"/>
	<path d="M10.3 14H8a5 5 0 0 0-5 5v1h9"/>
	<circle cx="17.5" cy="14.5" r="2.5"/>
	<path d="M17.5 17v5l-1.2-1.2 1.2-1.2"/>
</svg>`);

/**
 * Client-side script for the signed-in page.
 *
 * Handles sign-out (POST `/auth/sign-out`, then reload so the server renders
 * the sign-in form) and passkey registration (revealed only when the browser
 * supports WebAuthn; runs the register ceremony against this same-origin
 * session cookie via `window.epicenterPasskey`).
 */
const SIGNED_IN_SCRIPT = raw(`<script>
(() => {
	const signOutBtn = document.getElementById('sign-out');
	if (signOutBtn) {
		signOutBtn.addEventListener('click', async () => {
			signOutBtn.disabled = true;
			signOutBtn.textContent = 'Signing out\u2026';
			try {
				await fetch('/auth/sign-out', {
					method: 'POST',
					credentials: 'include',
				});
			} catch {}
			window.location.reload();
		});
	}

	const passkeyRow = document.getElementById('add-passkey-row');
	const addPasskeyBtn = document.getElementById('add-passkey');
	const passkeyMsg = document.getElementById('passkey-msg');
	if (passkeyRow && addPasskeyBtn && window.epicenterPasskey?.supported()) {
		passkeyRow.classList.remove('hidden');
		addPasskeyBtn.addEventListener('click', async () => {
			passkeyMsg.className = 'msg hidden';
			addPasskeyBtn.disabled = true;
			const label = addPasskeyBtn.querySelector('.btn-label');
			const original = label ? label.textContent : '';
			if (label) label.textContent = 'Follow your browser\u2026';
			const result = await window.epicenterPasskey.register();
			if (result.ok) {
				passkeyMsg.textContent = 'Passkey added. You can use it to sign in next time.';
				passkeyMsg.className = 'msg ok';
				if (label) label.textContent = 'Add another passkey';
			} else {
				passkeyMsg.textContent = result.error;
				passkeyMsg.className = 'msg err';
				if (label) label.textContent = original;
			}
			addPasskeyBtn.disabled = false;
		});
	}
})();
</script>`);

/**
 * Server-rendered "you're signed in" page.
 *
 * Shown when an authenticated user visits `/sign-in` without any OAuth
 * or callbackURL params. They don't need the sign-in form, just
 * confirmation that they're authenticated.
 */
export function SignedInPage({
	displayName,
	email,
}: {
	displayName: string;
	email: string;
}) {
	return (
		<div class="signed-in-center">
			{CHECK_ICON}
			<h1>You're signed in</h1>
			<p class="subtitle" style="margin-bottom:0">
				{displayName}
			</p>
			<p class="signed-in-info">{email}</p>

			<div id="passkey-msg" class="msg hidden" />

			<div class="signed-in-actions">
				{/* Revealed by the script only when WebAuthn is supported. */}
				<div id="add-passkey-row" class="hidden">
					<button
						type="button"
						class="btn btn-outline btn-provider"
						id="add-passkey"
					>
						{PASSKEY_ICON}
						<span class="btn-label">Add a passkey</span>
					</button>
				</div>
				<button type="button" class="btn btn-outline" id="sign-out">
					Sign out
				</button>
			</div>

			{PASSKEY_SCRIPT}
			{SIGNED_IN_SCRIPT}
		</div>
	);
}
