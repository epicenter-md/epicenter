import { raw } from 'hono/html';

/**
 * Client-side script for the sign-in page.
 *
 * Starts a social sign-in (Google, or GitHub / Microsoft / Apple when their
 * button is present) via `fetch` and displays errors. Includes `oauth_query`
 * (signed URL params) in the request so Better Auth's after-hook can continue
 * the OAuth flow. On success, navigates to the returned redirect URL or the
 * followed redirect. Local email/password is disabled (see
 * {@link BASE_AUTH_CONFIG}); the GitHub, Microsoft, and Apple buttons only
 * exist when the deployment configured that provider's credentials.
 */
export const SIGN_IN_SCRIPT = raw(`<script>
(() => {
	const googleBtn = document.getElementById('google-btn');
	const githubBtn = document.getElementById('github-btn');
	const microsoftBtn = document.getElementById('microsoft-btn');
	const appleBtn = document.getElementById('apple-btn');
	const msg = document.getElementById('msg');
	const buttons = [googleBtn, githubBtn, microsoftBtn, appleBtn].filter(Boolean);

	const LABELS = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft', apple: 'Apple' };

	// Replicate what oauthProviderClient does: parse the signed OAuth
	// query params from the URL so Better Auth can continue the flow.
	const getOAuthQuery = () => {
		const params = new URLSearchParams(window.location.search);
		return params.has('sig') ? params.toString() : undefined;
	};

	const showError = (text) => {
		msg.textContent = text;
		msg.className = 'msg err';
	};

	const clearError = () => {
		msg.className = 'msg hidden';
	};

	const setBusy = (busy) => {
		for (const button of buttons) button.disabled = busy;
	};

	const startSocial = async (provider) => {
		clearError();
		setBusy(true);

		try {
			const body = {
				provider: provider,
				callbackURL: window.location.href,
			};
			const oauthQuery = getOAuthQuery();
			if (oauthQuery) body.oauth_query = oauthQuery;

			const res = await fetch('/auth/sign-in/social', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(body),
			});

			const data = await res.json().catch(() => ({}));
			if (data.url) {
				window.location.href = data.url;
			} else if (res.redirected) {
				window.location.href = res.url;
			} else {
				showError(data.message || data.error || 'Failed to start ' + LABELS[provider] + ' sign-in.');
				setBusy(false);
			}
		} catch (err) {
			showError('Network error. Check your connection and try again.');
			setBusy(false);
		}
	};

	googleBtn.addEventListener('click', () => startSocial('google'));
	if (githubBtn) githubBtn.addEventListener('click', () => startSocial('github'));
	if (microsoftBtn)
		microsoftBtn.addEventListener('click', () => startSocial('microsoft'));
	if (appleBtn) appleBtn.addEventListener('click', () => startSocial('apple'));

	// Passkey is a returning-user path: only reveal it when the browser can do
	// WebAuthn, so first-time users are not offered a dead button. On success
	// the session cookie is set, so a reload lets the server continue the OAuth
	// authorize flow (the '?sig=' branch) exactly as a social sign-in would.
	const passkeySection = document.getElementById('passkey-section');
	const passkeyBtn = document.getElementById('passkey-btn');
	if (passkeySection && passkeyBtn && window.epicenterPasskey?.supported()) {
		passkeySection.classList.remove('hidden');
		passkeyBtn.addEventListener('click', async () => {
			clearError();
			setBusy(true);
			passkeyBtn.disabled = true;
			const result = await window.epicenterPasskey.authenticate();
			if (result.ok) {
				window.location.reload();
				return;
			}
			showError(result.error);
			setBusy(false);
			passkeyBtn.disabled = false;
		});
	}
})();
</script>`);
