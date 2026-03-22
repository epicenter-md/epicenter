/**
 * `epicenter auth` \u2014 manage authentication with Epicenter servers.
 *
 * Supports two auth flows:
 * - Password login: interactive email/password prompt (default for TTY)
 * - Device code: RFC 8628 flow for headless/CI environments (`--device`)
 *
 * All sessions stored in the unified auth store at `$EPICENTER_HOME/auth/sessions.json`.
 */

import type { Argv, CommandModule } from 'yargs';
import { createAuthApi } from '../auth/api';
import { loginWithDeviceCode } from '../auth/device-flow';
import {
	clearSession,
	loadDefaultSession,
	loadSession,
	normalizeServerUrl,
	saveSession,
} from '../auth/store';

async function readLine(prompt: string, silent = false): Promise<string> {
	const readline = await import('node:readline');

	const inputStream = process.stdin;
	let outputStream: NodeJS.WritableStream;

	if (silent) {
		const { Writable } = await import('node:stream');
		outputStream = new Writable({
			write(_, __, cb) {
				cb();
			},
		});
	} else {
		outputStream = process.stdout;
	}

	const rl = readline.createInterface({
		input: inputStream,
		output: outputStream,
		terminal: true,
	});

	process.stdout.write(prompt);

	return new Promise((resolve) => {
		rl.once('line', (line) => {
			if (silent) process.stdout.write('\n');
			rl.close();
			resolve(line);
		});
	});
}

function buildLoginCommand(home: string) {
	return {
		command: 'login',
		describe: 'Log in to an Epicenter server',
		builder: (yargs: Argv) =>
			yargs
				.option('server', {
					type: 'string',
					description: 'Server URL (e.g. https://api.epicenter.so)',
					demandOption: true,
				})
				.option('device', {
					type: 'boolean',
					description:
						'Use device code flow (headless/CI-friendly, opens browser)',
					default: false,
				}),
		handler: async (argv: any) => {
			const serverUrl = normalizeServerUrl(argv.server);

			// Device code flow: explicit --device or non-interactive stdin
			if (argv.device || !process.stdin.isTTY) {
				await loginWithDeviceCode(serverUrl, home);
				return;
			}

			// Password flow
			const email = await readLine('Email: ');
			const password = await readLine('Password: ', true);

			const api = createAuthApi(serverUrl);

			let response: any;
			try {
				response = await api.signInWithEmail(email, password);
			} catch (err) {
				console.error(`Login failed: ${(err as Error).message}`);
				process.exit(1);
			}

			await saveSession(home, {
				server: serverUrl,
				accessToken: response.token,
				createdAt: Date.now(),
				expiresIn: 60 * 60 * 24 * 7,
				user: response.user,
			});

			const displayName = response.user.name ?? response.user.email;
			console.log(`\u2713 Logged in as ${displayName} (${response.user.email})`);
		},
	};
}

function buildLogoutCommand(home: string) {
	return {
		command: 'logout',
		describe: 'Log out from an Epicenter server',
		builder: (yargs: Argv) =>
			yargs.option('server', {
				type: 'string',
				description:
					'Server URL to log out from (default: most recent session)',
			}),
		handler: async (argv: any) => {
			const session = argv.server
				? await loadSession(home, argv.server)
				: await loadDefaultSession(home);

			if (!session) {
				console.log('No active session.');
				return;
			}

			// Best-effort remote sign-out
			try {
				const api = createAuthApi(session.server, session.accessToken);
				await api.signOut();
			} catch {
				// Remote may be unreachable
			}

			await clearSession(home, session.server);
			console.log('\u2713 Logged out.');
		},
	};
}

function buildStatusCommand(home: string) {
	return {
		command: 'status',
		describe: 'Show current authentication status',
		builder: (yargs: Argv) =>
			yargs.option('server', {
				type: 'string',
				description: 'Server URL to check (default: most recent session)',
			}),
		handler: async (argv: any) => {
			const session = argv.server
				? await loadSession(home, argv.server)
				: await loadDefaultSession(home);

			if (!session) {
				console.log('Not logged in.');
				return;
			}

			const api = createAuthApi(session.server, session.accessToken);

			try {
				const remote = await api.getSession();
				const displayName = remote.user.name ?? remote.user.email;
				console.log(`Logged in as: ${displayName} (${remote.user.email})`);
				console.log(`Server:       ${session.server}`);
				console.log(`Session:      valid`);
				if (remote.session.expiresAt) {
					console.log(`Expires at:   ${new Date(remote.session.expiresAt).toLocaleString()}`);
				}
			} catch {
				const displayName = session.user?.name ?? session.user?.email ?? '(unknown)';
				console.log(`Logged in as: ${displayName} [stored]`);
				console.log(`Server:       ${session.server}`);
				console.warn('Warning: Could not verify session with remote server.');
			}
		},
	};
}

/**
 * Build the `auth` command group.
 */
export function buildAuthCommand(home: string): CommandModule {
	return {
		command: 'auth <subcommand>',
		describe: 'Manage authentication with Epicenter servers',
		builder: (yargs: Argv) =>
			yargs
			.command(buildLoginCommand(home) as unknown as CommandModule)
			.command(buildLogoutCommand(home) as unknown as CommandModule)
			.command(buildStatusCommand(home) as unknown as CommandModule)
				.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
		handler: () => {},
	};
}
