import { basename } from 'node:path';
import { bootstrap } from '@epicenter/opencode/cli/bootstrap.ts';
import { Provider } from '@epicenter/opencode/provider/provider.ts';
import { Server } from '@epicenter/opencode/server/server.ts';
import { Share } from '@epicenter/opencode/share/share.ts';
import { Log } from '@epicenter/opencode/util/log.ts';
import getPort from 'get-port';
import { BrowserServiceLive } from '../services/browser';
import type { TunnelProvider } from '../services/tunnel';
import { createTunnelService } from '../services/tunnel';
import { cmd } from '../utils/cmd';

const EPICENTER_SH_URL = 'https://epicenter.sh' as const;

export const ShCommand = cmd({
	command: 'sh',
	builder: (yargs) =>
		yargs
			.option('port', {
				alias: ['p'],
				type: 'number',
				describe:
					'port to listen on (auto-discovered by default, if conflict, use --port)',
			})
			.option('hostname', {
				type: 'string',
				describe: 'hostname to listen on',
				default: '127.0.0.1',
			})
			.option('cors-origins', {
				alias: ['c'],
				type: 'array',
				describe: 'CORS allowed origins',
				default: [EPICENTER_SH_URL],
			})
			.option('tunnel', {
				alias: ['t'],
				type: 'string',
				describe: 'enable tunnel with specified provider',
				choices: ['cloudflare', 'ngrok'],
				default: 'cloudflare',
			})
			.option('open', {
				alias: ['o'],
				type: 'boolean',
				describe: 'open tunnel URL in browser (use --no-open to disable)',
				default: true,
			}),
	describe: 'starts opencode server with epicenter.sh integration',
	handler: async (args) => {
		const cwd = process.cwd();
		await bootstrap({ cwd }, async () => {
			const providers = await Provider.list();
			if (Object.keys(providers).length === 0) {
				return 'needs_provider';
			}

			const hostname = args.hostname;
			const port = await getPort({ port: args.port });
			const corsOrigins = (args['cors-origins'] ?? []).map(String);
			const tunnelProvider = args.tunnel as TunnelProvider;
			const tunnelService = createTunnelService(tunnelProvider);

			Share.init();
			const server = Server.listen({
				port,
				hostname,
				corsOrigins,
			});

			const localUrl = `http://${server.hostname}:${server.port}`;

			// Display server information
			if (tunnelProvider) {
				console.log(`\n✓ Server running with ${tunnelProvider} tunnel\n`);
			} else {
				console.log('\n✓ Server running\n');
			}
			console.log(`  Local:      ${localUrl}`);

			// Show loading state for tunnel
			if (tunnelProvider) {
				// Simple loading animation
				const loadingFrames = [
					'⠋',
					'⠙',
					'⠹',
					'⠸',
					'⠼',
					'⠴',
					'⠦',
					'⠧',
					'⠇',
					'⠏',
				];
				let frameIndex = 0;
				process.stdout.write('  Tunnel:     Creating tunnel...');

				const loadingInterval = setInterval(() => {
					process.stdout.write(
						`\r  Tunnel:     ${loadingFrames[frameIndex]} Creating tunnel...`,
					);
					frameIndex = (frameIndex + 1) % loadingFrames.length;
				}, 80);

				// Ensure the tunnel provider is installed
				const { error: ensureInstalledError } =
					await tunnelService.ensureInstalled();
				if (ensureInstalledError) {
					clearInterval(loadingInterval);
					process.stdout.write(
						'\r  Tunnel:     ✗ Failed to install tunnel provider\n',
					);
					console.error(ensureInstalledError.message);
					process.exit(1);
				}

				// Start the tunnel
				const { data: tunnelUrl, error: tunnelError } =
					await tunnelService.startTunnel(port);

				clearInterval(loadingInterval);

				if (tunnelError) {
					process.stdout.write('\r  Tunnel:     ✗ Failed to create tunnel\n');
					console.error(tunnelError.message);
					process.exit(1);
				}

				// Clear the loading line and show the tunnel URL
				process.stdout.write(`\r  Tunnel:     ${tunnelUrl}\n`);

				if (args.open) {
					const EPICENTER_ASSISTANT_URL =
						`${EPICENTER_SH_URL}/assistants` as const;
					const currentDirName = basename(cwd);
					const params = new URLSearchParams({
						url: tunnelUrl,
						name: currentDirName,
					});
					const url = `${EPICENTER_ASSISTANT_URL}?${params}` as const;
					console.log(`  Epicenter:  ${url}`);
					console.log();

					// Wait 1 second before opening browser
					await new Promise((resolve) => setTimeout(resolve, 1000));

					console.log('  Opening browser...');
					const { error: browserError } = await BrowserServiceLive.openUrl(url);
					if (browserError) {
						console.error('Failed to open browser:', browserError.message);
					}
				}
			}

			// Handle graceful shutdown
			const cleanup = () => {
				console.log('\nShutting down...');
				server.stop();
				const { error: stopError } = tunnelService.stopTunnel();
				if (stopError) {
					console.error('Failed to stop tunnel:', stopError.message);
				}
				process.exit(0);
			};

			process.on('SIGINT', cleanup);

			await new Promise(() => {});
		});
	},
});
