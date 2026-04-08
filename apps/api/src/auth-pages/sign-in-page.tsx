import { raw } from 'hono/html';
import { SIGN_IN_SCRIPT } from './scripts/sign-in';

/**
 * Google's multi-color logo SVG for the "Continue with Google" button.
 * Rendered as raw HTML to avoid JSX SVG attribute noise.
 */
const GOOGLE_ICON =
	raw(`<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
	<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
	<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
	<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
	<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
</svg>`);

/**
 * Server-rendered sign-in/sign-up page for the OAuth flow.
 *
 * Better Auth redirects here when a user needs to authenticate. The page
 * renders a form with email/password fields and a Google OAuth button.
 * After successful auth, Better Auth returns a redirect URL to continue
 * the OAuth flow. For non-OAuth sign-ins, the page reloads.
 */
export function SignInPage() {
	return (
		<>
			<h1 id="heading">Sign in</h1>
			<p class="subtitle" id="description">
				Sign in to your Epicenter account.
			</p>

			<div id="msg" class="msg hidden" />

			<button type="button" class="btn btn-outline" id="google-btn">
				{GOOGLE_ICON}
				Continue with Google
			</button>

			<div class="separator">or</div>

			<form id="auth-form">
				<div class="field" id="name-field" style="display:none">
					<label for="name">Name</label>
					<input id="name" type="text" placeholder="Name" autocomplete="name" />
				</div>
				<div class="field">
					<label for="email">Email</label>
					<input
						id="email"
						type="email"
						placeholder="Email"
						required
						autocomplete="email"
					/>
				</div>
				<div class="field">
					<label for="password">Password</label>
					<input
						id="password"
						type="password"
						placeholder="Password"
						required
						autocomplete="current-password"
					/>
				</div>

				<button type="submit" class="btn btn-primary" id="submit-btn">
					<span id="submit-text">Sign in</span>
				</button>
			</form>

			<p class="toggle">
				<span id="toggle-prompt">Don't have an account? </span>
				<button type="button" id="toggle-btn">
					Sign up
				</button>
			</p>

			{SIGN_IN_SCRIPT}
		</>
	);
}
