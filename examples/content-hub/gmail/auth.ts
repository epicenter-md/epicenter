import path from 'node:path';
import type { EpicenterDir } from '@epicenter/hq';
import { google } from 'googleapis';
import open from 'open';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GmailTokens = {
	access_token: string;
	refresh_token: string;
	expiry_date: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

const { GmailAuthErr } = createTaggedError<
	'GmailAuthError',
	{ operation: string; details?: string }
>('GmailAuthError');

const { GmailTokenErr } = createTaggedError<
	'GmailTokenError',
	{ operation: string; details?: string }
>('GmailTokenError');

export { GmailAuthErr, GmailTokenErr };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SCOPES = [
	'https://www.googleapis.com/auth/gmail.readonly',
	'https://www.googleapis.com/auth/gmail.modify',
];

// ─────────────────────────────────────────────────────────────────────────────
// Token Storage
// ─────────────────────────────────────────────────────────────────────────────

function getTokenPath(epicenterDir: EpicenterDir): string {
	return path.join(epicenterDir, 'gmail-token.json');
}

export async function loadTokens(epicenterDir: EpicenterDir) {
	const tokenPath = getTokenPath(epicenterDir);
	const file = Bun.file(tokenPath);

	const { data: exists, error: existsError } = await tryAsync({
		try: () => file.exists(),
		catch: () => Ok(false),
	});

	if (existsError || !exists) {
		return Ok(null);
	}

	const { data: tokens, error: parseError } = await tryAsync({
		try: async () => {
			const text = await file.text();
			return JSON.parse(text) as GmailTokens;
		},
		catch: (e) =>
			GmailTokenErr({
				message: 'Failed to parse token file',
				context: {
					operation: 'loadTokens',
					details: extractErrorMessage(e),
				},
			}),
	});

	if (parseError) return Err(parseError);
	return Ok(tokens);
}

export async function saveTokens(
	epicenterDir: EpicenterDir,
	tokens: GmailTokens,
) {
	const tokenPath = getTokenPath(epicenterDir);

	const { error } = await tryAsync({
		try: () => Bun.write(tokenPath, JSON.stringify(tokens, null, 2)),
		catch: (e) =>
			GmailTokenErr({
				message: 'Failed to save token file',
				context: {
					operation: 'saveTokens',
					details: extractErrorMessage(e),
				},
			}),
	});

	if (error) return Err(error);
	return Ok(undefined);
}

export async function deleteTokens(epicenterDir: EpicenterDir) {
	const tokenPath = getTokenPath(epicenterDir);
	const fs = await import('node:fs/promises');

	const { error } = await tryAsync({
		try: () => fs.unlink(tokenPath),
		catch: (e) => {
			// Ignore if file doesn't exist
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				return Ok(undefined);
			}
			return GmailTokenErr({
				message: 'Failed to delete token file',
				context: {
					operation: 'deleteTokens',
					details: extractErrorMessage(e),
				},
			});
		},
	});

	if (error) return Err(error);
	return Ok(undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Client
// ─────────────────────────────────────────────────────────────────────────────

function getCredentials() {
	const clientId = process.env.GMAIL_CLIENT_ID;
	const clientSecret = process.env.GMAIL_CLIENT_SECRET;

	if (!clientId || !clientSecret) {
		return Err(
			GmailAuthErr({
				message: 'Missing Gmail credentials',
				context: {
					operation: 'getCredentials',
					details:
						'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables',
				},
			}),
		);
	}

	return Ok({ clientId, clientSecret });
}

export function createOAuth2Client(redirectUri?: string) {
	const credentialsResult = getCredentials();
	if (credentialsResult.error) return credentialsResult;

	const { clientId, clientSecret } = credentialsResult.data;
	const oauth2Client = new google.auth.OAuth2(
		clientId,
		clientSecret,
		redirectUri,
	);

	return Ok(oauth2Client);
}

export async function getAuthenticatedClient(epicenterDir: EpicenterDir) {
	const { data: tokens, error: loadError } = await loadTokens(epicenterDir);
	if (loadError) return Err(loadError);

	if (!tokens) {
		return GmailAuthErr({
			message: 'Not authenticated',
			context: {
				operation: 'getAuthenticatedClient',
				details: 'Run login first to authenticate with Gmail',
			},
		});
	}

	const { data: oauth2Client, error: clientError } = createOAuth2Client();
	if (clientError) return Err(clientError);

	oauth2Client.setCredentials(tokens);

	// Listen for token refresh events
	oauth2Client.on('tokens', async (newTokens) => {
		const updatedTokens: GmailTokens = {
			access_token: newTokens.access_token ?? tokens.access_token,
			refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
			expiry_date: newTokens.expiry_date ?? tokens.expiry_date,
		};
		await saveTokens(epicenterDir, updatedTokens);
	});

	return Ok(oauth2Client);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Login Flow
// ─────────────────────────────────────────────────────────────────────────────

export async function performOAuthLogin(epicenterDir: EpicenterDir) {
	// Start server on dynamic port
	let resolveAuth: (code: string) => void;
	let rejectAuth: (error: Error) => void;

	const authPromise = new Promise<string>((resolve, reject) => {
		resolveAuth = resolve;
		rejectAuth = reject;
	});

	const server = Bun.serve({
		port: 0, // Dynamic port
		fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === '/callback') {
				const code = url.searchParams.get('code');
				const error = url.searchParams.get('error');

				if (error) {
					rejectAuth(new Error(`OAuth error: ${error}`));
					return new Response(
						'<html><body><h1>Authentication failed</h1><p>You can close this window.</p></body></html>',
						{ headers: { 'Content-Type': 'text/html' } },
					);
				}

				if (code) {
					resolveAuth(code);
					return new Response(
						'<html><body><h1>Authentication successful!</h1><p>You can close this window and return to the terminal.</p></body></html>',
						{ headers: { 'Content-Type': 'text/html' } },
					);
				}

				return new Response('Missing code parameter', { status: 400 });
			}

			return new Response('Not found', { status: 404 });
		},
	});

	const redirectUri = `http://localhost:${server.port}/callback`;

	// Create OAuth2 client with redirect URI
	const { data: oauth2Client, error: clientError } =
		createOAuth2Client(redirectUri);
	if (clientError) {
		server.stop();
		return Err(clientError);
	}

	// Generate auth URL
	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		scope: SCOPES,
		prompt: 'consent', // Force consent to get refresh_token
	});

	// Open browser using platform-specific command
	console.log(`Opening browser for Gmail authentication...`);
	console.log(`If browser doesn't open, visit: ${authUrl}`);

	const { error: openError } = await tryAsync({
		try: () => open(authUrl),
		catch: (e) =>
			GmailAuthErr({
				message: 'Failed to open browser',
				context: {
					operation: 'performOAuthLogin',
					details: extractErrorMessage(e),
				},
			}),
	});

	if (openError) {
		server.stop();
		return Err(openError);
	}

	// Wait for callback
	const { data: code, error: authError } = await tryAsync({
		try: () => authPromise,
		catch: (e) =>
			GmailAuthErr({
				message: 'OAuth callback failed',
				context: {
					operation: 'performOAuthLogin',
					details: extractErrorMessage(e),
				},
			}),
	});

	server.stop();

	if (authError) return Err(authError);

	// Exchange code for tokens
	const { data: tokenResponse, error: exchangeError } = await tryAsync({
		try: () => oauth2Client.getToken(code),
		catch: (e) =>
			GmailAuthErr({
				message: 'Failed to exchange code for tokens',
				context: {
					operation: 'performOAuthLogin',
					details: extractErrorMessage(e),
				},
			}),
	});

	if (exchangeError) return Err(exchangeError);

	const credentials = tokenResponse.tokens;

	if (!credentials.access_token || !credentials.refresh_token) {
		return GmailAuthErr({
			message: 'Invalid token response',
			context: {
				operation: 'performOAuthLogin',
				details: 'Missing access_token or refresh_token',
			},
		});
	}

	const tokens: GmailTokens = {
		access_token: credentials.access_token,
		refresh_token: credentials.refresh_token,
		expiry_date: credentials.expiry_date ?? Date.now() + 3600 * 1000,
	};

	// Save tokens
	const { error: saveError } = await saveTokens(epicenterDir, tokens);
	if (saveError) return Err(saveError);

	return Ok(undefined);
}
