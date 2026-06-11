/** @jsxImportSource hono/jsx */

import { raw } from 'hono/html';

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
 * Client-side script for the signed-in page.
 *
 * Handles the sign-out button: POST to `/auth/sign-out`, then reload
 * so the server renders the sign-in form.
 */
const SIGNED_IN_SCRIPT = raw(`<script>
(() => {
	const signOutBtn = document.getElementById('sign-out');
	if (!signOutBtn) return;

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

			<div class="signed-in-actions">
				<button type="button" class="btn btn-outline" id="sign-out">
					Sign out
				</button>
			</div>

			{SIGNED_IN_SCRIPT}
		</div>
	);
}
