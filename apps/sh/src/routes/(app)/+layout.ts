import { redirect } from '@sveltejs/kit';
import { authClient } from '$lib/auth-client';
import * as rpc from '$lib/query';

export async function load() {
	const { data: session, error: getSessionError } =
		await rpc.auth.getSession.ensure();
	if (getSessionError) redirect(302, '/');

	// If a session exists, return it
	if (session) return { session };

	// No session exists, sign in anonymously
	const { error: anonError } = await authClient.signIn.anonymous();
	if (anonError) redirect(302, '/');
	// Then redirect to the assistants page
	return redirect(302, '/assistants');
}
