import { error } from '@sveltejs/kit';
import type { SignInContext } from '$lib/auth/sign-in-context';
import type { PageLoad } from './$types';

/**
 * Bootstrap the sign-in surface from the server's one JSON endpoint: session
 * presence (signed-in card) and provider enablement (which buttons exist).
 * The server already handled the redirect cases (`sig` re-entry, safe
 * `callbackURL`) before serving this page's shell, so by the time this load
 * runs, the answer is always "render something".
 */
export const load: PageLoad = async ({ fetch }) => {
	const response = await fetch('/sign-in/context');
	if (!response.ok) {
		error(response.status, 'Could not load the sign-in page. Try reloading.');
	}
	const context: SignInContext = await response.json();
	return { context };
};
