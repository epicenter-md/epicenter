import type { ParsedArgs } from '../cli.ts';
import { loadConfig } from '../config.ts';
import { runAuthorizationFlow } from '../oauth.ts';
import { createFileTokenStore } from '../token-store.ts';
import { formatRelative } from './context.ts';

/**
 * One-time interactive OAuth2: open the browser, capture the localhost callback,
 * exchange the code, and store the token set in the token store keyed by realmId.
 */
export async function runAuth(args: ParsedArgs): Promise<number> {
	// No `realm` override: `auth` connects whatever company the browser logs into
	// and takes the realmId from the OAuth callback, so `--realm` does not apply.
	const config = loadConfig({ environment: args.environment });

	// Credentials are resolved lazily inside the flow by their environment-qualified
	// names (ADR-0108); a missing keyset returns a MissingCredentials error naming
	// the exact `QB_<ENV>_*` variables, surfaced below before any browser opens.
	const store = createFileTokenStore(config.credentialsPath);

	console.error(`Authenticating against QuickBooks (${config.environment})...`);
	const { data: token, error } = await runAuthorizationFlow(config, {
		now: () => Date.now(),
		log: (m) => console.error(m),
	});
	if (error) {
		// Each OAuthError message is already self-actionable (a missing keyset names
		// the exact variables; a denial or timeout says to re-run), so print it as-is
		// rather than stacking a generic suffix.
		console.error(`Authentication failed: ${error.message}`);
		return 1;
	}

	// The store is the only record that this company is connected: it is keyed by
	// realmId, so writing the token is what makes `sync` and `status` find it
	// without `--realm` (ADR-0201).
	await store.set(token);

	const now = Date.now();
	console.log(`Connected company ${token.realmId} (${config.environment}).`);
	console.log(
		`Access token valid ${formatRelative(token.accessTokenExpiresAt, now)}.`,
	);
	console.log(
		`Refresh token valid ${formatRelative(token.refreshTokenExpiresAt, now)}.`,
	);
	console.log(`Tokens stored in ${config.credentialsPath}.`);
	console.log(`Next: "local-books sync --full" to build your local copy.`);
	return 0;
}
