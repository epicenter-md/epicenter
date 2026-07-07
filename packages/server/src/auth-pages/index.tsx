/** @jsxImportSource hono/jsx */

/**
 * Render functions for auth pages.
 *
 * Each function returns the full JSX tree (layout + page) ready to be
 * passed to `c.html()` in a Hono route handler. This keeps JSX contained
 * in `.tsx` files so `app.ts` doesn't need renaming.
 *
 * Two shells: the sign-in and signed-in pages render inside the two-pane
 * {@link AuthShell} (brand panel + auth pane), the consent and cli-callback
 * pages inside the centered {@link AuthCard}.
 */

import { CliCallbackPage } from './cli-callback-page';
import { ConsentPage } from './consent-page';
import { AuthCard, AuthLayout, AuthShell } from './layout';
import { SignInPage } from './sign-in-page';
import { SignedInPage } from './signed-in-page';

export function renderSignInPage({
	githubEnabled,
	microsoftEnabled,
	appleEnabled,
}: {
	githubEnabled: boolean;
	microsoftEnabled: boolean;
	appleEnabled: boolean;
}) {
	return (
		<AuthLayout title="Sign in: Epicenter" bodyClass="split">
			<AuthShell>
				<SignInPage
					githubEnabled={githubEnabled}
					microsoftEnabled={microsoftEnabled}
					appleEnabled={appleEnabled}
				/>
			</AuthShell>
		</AuthLayout>
	);
}

export function renderConsentPage({
	clientId,
	scope,
}: {
	clientId?: string;
	scope?: string;
}) {
	return (
		<AuthLayout title="Authorize: Epicenter" bodyClass="centered">
			<AuthCard>
				<ConsentPage clientId={clientId} scope={scope} />
			</AuthCard>
		</AuthLayout>
	);
}

export function renderSignedInPage({
	name,
	email,
}: {
	name: string;
	email: string;
}) {
	return (
		<AuthLayout title="Signed in: Epicenter" bodyClass="split">
			<AuthShell>
				<SignedInPage name={name} email={email} />
			</AuthShell>
		</AuthLayout>
	);
}

export function renderCliCallbackPage({
	code,
	state,
	error,
	errorDescription,
}: {
	code?: string;
	state?: string;
	error?: string;
	errorDescription?: string;
}) {
	return (
		<AuthLayout title="Epicenter CLI sign-in" bodyClass="centered">
			<AuthCard>
				<CliCallbackPage
					code={code}
					state={state}
					error={error}
					errorDescription={errorDescription}
				/>
			</AuthCard>
		</AuthLayout>
	);
}
