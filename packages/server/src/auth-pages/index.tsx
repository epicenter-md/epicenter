/** @jsxImportSource hono/jsx */

/**
 * Render functions for auth pages.
 *
 * Each function returns the full JSX tree (layout + page) ready to be
 * passed to `c.html()` in a Hono route handler. This keeps JSX contained
 * in `.tsx` files so `app.ts` doesn't need renaming.
 */

import { CliCallbackPage } from './cli-callback-page';
import { ConsentPage } from './consent-page';
import { AuthLayout } from './layout';
import { SignInPage } from './sign-in-page';
import { SignedInPage } from './signed-in-page';

export function renderSignInPage({
	githubEnabled,
}: {
	githubEnabled: boolean;
}) {
	return (
		<AuthLayout title="Sign in: Epicenter">
			<SignInPage githubEnabled={githubEnabled} />
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
		<AuthLayout title="Authorize: Epicenter">
			<ConsentPage clientId={clientId} scope={scope} />
		</AuthLayout>
	);
}

export function renderSignedInPage({
	displayName,
	email,
}: {
	displayName: string;
	email: string;
}) {
	return (
		<AuthLayout title="Signed in: Epicenter">
			<SignedInPage displayName={displayName} email={email} />
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
		<AuthLayout title="Epicenter CLI sign-in">
			<CliCallbackPage
				code={code}
				state={state}
				error={error}
				errorDescription={errorDescription}
			/>
		</AuthLayout>
	);
}
