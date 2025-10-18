import type { Subprocess } from 'bun';
import { $, spawn } from 'bun';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync, trySync } from 'wellcrafted/result';
import type { TunnelService } from './types';
import { TunnelServiceErr } from './types';

export function createTunnelServiceCloudflare(): TunnelService {
	let currentProcess: Subprocess | null = null;

	return {
		async ensureInstalled() {
			const { error } = await tryAsync({
				try: async () => {
					await $`cloudflared --version`.quiet();
				},
				catch: (error) => {
					return TunnelServiceErr({
						message: `cloudflared is not installed.\n\n${getInstallInstructions()}`,
						cause: error,
					});
				},
			});

			if (error) return Err(error);
			return Ok(undefined);
		},

		async startTunnel(port: number) {
			// Stop any existing tunnel before starting a new one
			if (currentProcess) this.stopTunnel();

			return tryAsync({
				try: async () => {
					const tunnelProc = spawn(
						['cloudflared', 'tunnel', '--url', `http://localhost:${port}`],
						{
							stdin: 'ignore',
							stdout: 'ignore',
							stderr: 'pipe',
						},
					);

					currentProcess = tunnelProc;

					// Read stderr for tunnel URL
					const decoder = new TextDecoder();
					let tunnelUrl: string | null = null;

					// Continue reading stderr in background to keep the process alive
					// This prevents the stderr buffer from filling up and blocking cloudflared
					(async () => {
						for await (const chunk of tunnelProc.stderr as any) {
							const data = decoder.decode(chunk);

							// Only process if we haven't found the URL yet
							if (!tunnelUrl) {
								// Parse the tunnel URL from the box format
								const urlMatch = data.match(
									/\|\s+(https:\/\/[^|]+\.trycloudflare\.com)\s+\|/,
								);

								if (urlMatch?.[1]) {
									tunnelUrl = urlMatch[1].trim();
								}
							}
							// Continue reading to prevent buffer overflow even after finding URL
						}
					})();

					// Wait for the tunnel URL to be found
					const MAX_WAIT = 30_000; // 30 seconds
					const POLL_INTERVAL = 100; // 100ms
					const startTime = Date.now();

					while (!tunnelUrl) {
						await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

						if (Date.now() - startTime > MAX_WAIT) {
							throw new Error('Timeout waiting for cloudflared tunnel URL');
						}

						// Check if process has exited
						if (tunnelProc.killed) {
							const exitCode = await tunnelProc.exited;
							throw new Error(
								`cloudflared process ended without providing URL${
									exitCode !== 0 ? ` (exit code: ${exitCode})` : ''
								}`,
							);
						}
					}

					return tunnelUrl;
				},
				catch: (error) =>
					TunnelServiceErr({
						message: `Failed to start cloudflared tunnel on port ${port}: ${extractErrorMessage(error)}`,
						cause: error,
					}),
			});
		},

		stopTunnel() {
			return trySync({
				try: () => {
					if (currentProcess && !currentProcess.killed) {
						currentProcess.kill('SIGTERM');
						currentProcess = null;
					}
				},
				catch: (error) =>
					TunnelServiceErr({
						message: `Failed to stop tunnel: ${extractErrorMessage(error)}`,
						cause: error,
					}),
			});
		},
	};
}

function getInstallInstructions(): string {
	const platform = process.platform;

	switch (platform) {
		case 'darwin':
			return (
				'Install cloudflared:\n' +
				'  # Homebrew: brew install cloudflared\n' +
				'  # Manual: Download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
			);
		case 'linux':
			return (
				'Install cloudflared:\n' +
				'  # Debian/Ubuntu (via Cloudflare package repository):\n' +
				'  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\n' +
				"  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main' | sudo tee /etc/apt/sources.list.d/cloudflared.list\n" +
				'  sudo apt-get update && sudo apt-get install cloudflared\n' +
				'  \n' +
				'  # RHEL/CentOS (via Cloudflare package repository):\n' +
				'  curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo | sudo tee /etc/yum.repos.d/cloudflared.repo\n' +
				'  sudo yum install cloudflared\n' +
				'  \n' +
				'  # Arch Linux: sudo pacman -S cloudflared\n' +
				'  # Manual: Download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
			);
		case 'win32':
			return (
				'Install cloudflared:\n' +
				'  # Winget (recommended): winget install --id=Cloudflare.cloudflared -e\n' +
				'  # Chocolatey: choco install cloudflared\n' +
				'  # Scoop: scoop install cloudflared\n' +
				'  # Manual: Download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
			);
		default:
			return 'Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
	}
}
