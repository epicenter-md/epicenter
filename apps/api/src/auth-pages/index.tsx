/**
 * Render functions for auth pages.
 *
 * Each function returns the full JSX tree (layout + page) ready to be
 * passed to `c.html()` in a Hono route handler. This keeps JSX contained
 * in `.tsx` files so `app.ts` doesn't need renaming.
 */

import { ConsentPage } from './consent-page';
import { DevicePage } from './device-page';
import { AuthLayout } from './layout';
import { SignInPage } from './sign-in-page';
import { SignedInPage } from './signed-in-page';

export function renderSignInPage() {
	return (
		<AuthLayout title="Sign in — Epicenter">
			<SignInPage />
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
		<AuthLayout title="Authorize — Epicenter">
			<ConsentPage clientId={clientId} scope={scope} />
		</AuthLayout>
	);
}

export function renderDevicePage({ userCode }: { userCode?: string }) {
	return (
		<AuthLayout title="Authorize Device — Epicenter">
			<DevicePage userCode={userCode} />
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
		<AuthLayout title="Signed in — Epicenter">
			<SignedInPage displayName={displayName} email={email} />
		</AuthLayout>
	);
}
