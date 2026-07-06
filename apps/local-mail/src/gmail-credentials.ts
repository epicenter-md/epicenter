type CredentialSource = (name: string) => string | undefined;

/**
 * Resolve the single Google OAuth Desktop client used by BYO Local Mail.
 * Local Mail is a local app: the operator supplies one client id/secret pair,
 * and the stored token records the concrete client id that minted it so refresh
 * can fail loudly if the configured client changes later.
 */
export function resolveGmailCredentials(
	read: CredentialSource = (name) => process.env[name],
): { clientId: string; clientSecret: string } {
	const clientId = read('GMAIL_CLIENT_ID');
	const clientSecret = read('GMAIL_CLIENT_SECRET');
	if (!clientId || !clientSecret) {
		const missing = [
			clientId ? null : 'GMAIL_CLIENT_ID',
			clientSecret ? null : 'GMAIL_CLIENT_SECRET',
		].filter((name): name is string => name !== null);
		throw new Error(
			`Missing Gmail OAuth credentials: set ${missing.join(' and ')} (see .env.example).`,
		);
	}

	return { clientId, clientSecret };
}
