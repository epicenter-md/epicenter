/** @jsxImportSource hono/jsx */

import { raw } from 'hono/html';

/**
 * Checkmark circle SVG for the signed-in confirmation. Colors come from the
 * stylesheet (`.success-icon circle` / `path`) so the icon follows the theme.
 */
const CHECK_ICON =
	raw(`<svg class="success-icon" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
	<circle cx="24" cy="24" r="24"/>
	<path d="M15 24.5L21 30.5L33 18.5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

/**
 * Client-side script for the signed-in page.
 *
 * Better Auth's `/auth/sign-out` endpoint rejects a bodyless POST with
 * 415 UNSUPPORTED_MEDIA_TYPE ("Content-Type is required"), so the request
 * must send `Content-Type: application/json` with a JSON body. On success,
 * navigate to `/sign-in` so the server renders the sign-in form; on failure,
 * restore the button and surface the error instead of pretending it worked.
 */
const SIGNED_IN_SCRIPT = raw(`<script>
(() => {
	const signOutBtn = document.getElementById('sign-out');
	const msg = document.getElementById('msg');
	if (!signOutBtn) return;

	signOutBtn.addEventListener('click', async () => {
		signOutBtn.disabled = true;
		signOutBtn.textContent = 'Signing out…';
		msg.className = 'msg hidden';
		try {
			const res = await fetch('/auth/sign-out', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: '{}',
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message || 'Sign-out failed (' + res.status + ').');
			}
			window.location.replace('/sign-in');
		} catch (err) {
			signOutBtn.disabled = false;
			signOutBtn.textContent = 'Sign out';
			msg.textContent =
				err && err.message ? err.message : 'Sign-out failed. Try again.';
			msg.className = 'msg err';
		}
	});
})();
</script>`);

/**
 * Server-rendered "you're signed in" page.
 *
 * Shown when an authenticated user visits `/sign-in` without any OAuth or
 * callbackURL params (both of those redirect before this renders). They don't
 * need the sign-in form, just confirmation of which account this browser
 * holds. The name renders only when it is a real name: Better Auth falls back
 * to the email for `user.name`, and showing the same string twice reads as a
 * rendering bug.
 */
export function SignedInPage({
	name,
	email,
}: {
	name: string;
	email: string;
}) {
	const hasRealName =
		name.trim().length > 0 &&
		name.trim().toLowerCase() !== email.trim().toLowerCase();

	return (
		<>
			{CHECK_ICON}
			<h1>You're signed in</h1>
			{hasRealName ? <p class="identity-name">{name}</p> : null}
			<p class="identity-email">{email}</p>
			<p class="ready-line">This browser is ready for Epicenter.</p>

			<div id="msg" class="msg hidden" />

			<div class="signed-in-actions">
				<button type="button" class="btn btn-outline" id="sign-out">
					Sign out
				</button>
			</div>

			{SIGNED_IN_SCRIPT}
		</>
	);
}
