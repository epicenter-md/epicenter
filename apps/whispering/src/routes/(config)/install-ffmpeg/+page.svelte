<script lang="ts">
	import { Button, buttonVariants } from '@repo/ui/button';
	import { Link } from '@repo/ui/link';
	import * as Card from '@repo/ui/card';
	import * as Alert from '@repo/ui/alert';
	import { Snippet } from '@repo/ui/snippet';
	import { Badge } from '@repo/ui/badge';
	import {
		DownloadIcon,
		CheckCircleIcon,
		XCircleIcon,
		LoaderIcon,
		RefreshCwIcon,
		ExternalLinkIcon,
	} from '@lucide/svelte';
	import * as services from '$lib/services';
	import { goto } from '$app/navigation';
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	const platform = services.os.type();

	// Query to check FFmpeg installation status
	const ffmpegQuery = createQuery(() => ({
		...rpc.ffmpeg.checkFfmpegInstalled.options(),
		refetchInterval: (query) => {
			// Refetch every 5 seconds if not installed, every 30 seconds if installed
			const isInstalled = query.state.data;
			return isInstalled ? 30000 : 5000;
		},
		refetchOnWindowFocus: true,
		staleTime: 1000,
	}));
</script>

<svelte:head>
	<title>Install FFmpeg - Whispering</title>
</svelte:head>

<main class="flex flex-1 items-center justify-center p-4">
	<Card.Root class="w-full min-w-[640px] max-w-4xl">
		<Card.Header>
			<div class="flex items-center justify-between">
				<div class="space-y-1.5">
					<Card.Title class="text-2xl">Install FFmpeg</Card.Title>
					<Card.Description>
						We highly recommend installing FFmpeg for enhanced audio processing
						in Whispering. FFmpeg converts audio files to WAV format for Whisper
						C++ transcription and compresses native audio files for efficient
						transmission to transcription services.
					</Card.Description>
				</div>

				<!-- Status indicator -->
				<div class="flex items-center gap-2">
					{#if ffmpegQuery.isPending}
						<Badge variant="secondary" class="gap-1.5">
							<LoaderIcon class="size-3 animate-spin" />
							Checking
						</Badge>
					{:else if ffmpegQuery.data === true}
						<Badge
							variant="default"
							class="gap-1.5 bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
						>
							<CheckCircleIcon class="size-3" />
							Installed
						</Badge>
					{:else if ffmpegQuery.data === false}
						<Badge variant="destructive" class="gap-1.5">
							<XCircleIcon class="size-3" />
							Not Found
						</Badge>
					{/if}

					<Button
						size="icon"
						variant="ghost"
						onclick={() => ffmpegQuery.refetch()}
						title="Check again"
						class="size-8"
					>
						<RefreshCwIcon
							class="size-4 {ffmpegQuery.isFetching ? 'animate-spin' : ''}"
						/>
					</Button>
				</div>
			</div>
		</Card.Header>

		<Card.Content class="space-y-6">
			{#if ffmpegQuery.data === true}
				<!-- Success state -->
				<Alert.Root class="border-green-500/20 bg-green-500/5">
					<CheckCircleIcon class="size-4 text-green-600 dark:text-green-400" />
					<Alert.Title class="text-green-600 dark:text-green-400">
						FFmpeg is installed!
					</Alert.Title>
					<Alert.Description>
						FFmpeg has been detected on your system. You can now use all audio
						processing features.
					</Alert.Description>
				</Alert.Root>

				<div class="flex gap-3">
					<Link
						href="/settings/transcription"
						class={buttonVariants({ class: 'flex-1' })}
					>
						Continue to Settings
					</Link>
					<Button variant="outline" onclick={() => goto('/')}>
						Go to Home
					</Button>
				</div>
			{:else}
				<!-- Installation instructions -->
				{#if platform === 'macos'}
					<!-- macOS Installation -->
					<div class="space-y-4">
						<h3 class="text-lg font-semibold">macOS Installation</h3>

						<div class="space-y-3">
							<p class="text-sm font-medium">
								Option 1: Using Homebrew (Recommended)
							</p>
							<Snippet text="brew install ffmpeg" />

							<p class="text-xs text-muted-foreground">
								Don't have Homebrew?
								<Link
									href="https://brew.sh"
									target="_blank"
									rel="noopener noreferrer"
								>
									Install it from brew.sh
								</Link>
							</p>
						</div>

						<div class="space-y-3">
							<p class="text-sm font-medium">Option 2: Direct Download</p>
							<Button
								href="https://evermeet.cx/ffmpeg/"
								target="_blank"
								rel="noopener noreferrer"
								variant="outline"
							>
								<DownloadIcon class="size-4 mr-2" />
								Download FFmpeg for macOS
							</Button>
						</div>

						<!-- Verify section -->
						<div class="border-t pt-4">
							<p class="text-sm font-medium mb-2">Verify Installation</p>
							<p class="text-sm text-muted-foreground mb-2">
								After installation, verify FFmpeg is working by running this
								command:
							</p>
							<Snippet text="ffmpeg -version" variant="secondary" />
						</div>
					</div>
				{:else if platform === 'windows'}
					<!-- Windows Installation -->
					<div class="space-y-4">
						<h3 class="text-lg font-semibold">Windows Installation</h3>

						<div class="space-y-3">
							<p class="text-sm font-medium">
								Option 1: Using winget (Windows 11/10)
							</p>
							<ol
								class="text-sm text-muted-foreground list-decimal list-inside space-y-2"
							>
								<li>Open Command Prompt as Administrator</li>
								<li>Run this command:</li>
							</ol>
							<Snippet text="winget install ffmpeg" />
						</div>

						<div class="space-y-3">
							<p class="text-sm font-medium">Option 2: Manual Installation</p>
							<ol
								class="text-sm text-muted-foreground list-decimal list-inside space-y-2"
							>
								<li>Download FFmpeg from the official website:</li>
							</ol>
							<Button
								href="https://www.gyan.dev/ffmpeg/builds/"
								target="_blank"
								rel="noopener noreferrer"
								variant="outline"
								class="my-2"
							>
								<DownloadIcon class="size-4 mr-2" />
								Download FFmpeg for Windows
							</Button>
							<ol
								class="text-sm text-muted-foreground list-decimal list-inside space-y-2"
								start="2"
							>
								<li>
									Choose "release builds" → "ffmpeg-release-essentials.zip"
								</li>
								<li>
									Extract the ZIP file to <code
										class="bg-muted px-1.5 py-0.5 rounded text-xs font-mono"
										>C:\ffmpeg</code
									>
								</li>
								<li>
									Add <code
										class="bg-muted px-1.5 py-0.5 rounded text-xs font-mono"
										>C:\ffmpeg\bin</code
									> to your PATH
								</li>
								<li>Restart Whispering for the changes to take effect</li>
							</ol>
						</div>

						<!-- Verify section -->
						<div class="border-t pt-4">
							<p class="text-sm font-medium mb-2">Verify Installation</p>
							<p class="text-sm text-muted-foreground mb-2">
								After installation, verify FFmpeg is working by running this
								command:
							</p>
							<Snippet text="ffmpeg -version" variant="secondary" />
						</div>
					</div>
				{:else if platform === 'linux'}
					<!-- Linux Installation -->
					<div class="space-y-4">
						<h3 class="text-lg font-semibold">Linux Installation</h3>

						<div class="space-y-4">
							<div>
								<p class="text-sm font-medium mb-2">Ubuntu/Debian:</p>
								<Snippet text="sudo apt update && sudo apt install ffmpeg" />
							</div>

							<div>
								<p class="text-sm font-medium mb-2">Fedora/RHEL:</p>
								<Snippet text="sudo dnf install ffmpeg" />
							</div>

							<div>
								<p class="text-sm font-medium mb-2">Arch Linux:</p>
								<Snippet text="sudo pacman -S ffmpeg" />
							</div>
						</div>

						<!-- Verify section -->
						<div class="border-t pt-4">
							<p class="text-sm font-medium mb-2">Verify Installation</p>
							<p class="text-sm text-muted-foreground mb-2">
								After installation, verify FFmpeg is working by running this
								command:
							</p>
							<Snippet text="ffmpeg -version" variant="secondary" />
						</div>
					</div>
				{:else}
					<!-- Generic/Unknown Platform -->
					<div class="space-y-4">
						<h3 class="text-lg font-semibold">Download FFmpeg</h3>
						<p class="text-muted-foreground text-sm">
							Visit the official FFmpeg download page for your operating system:
						</p>
						<Button
							href="https://ffmpeg.org/download.html"
							target="_blank"
							rel="noopener noreferrer"
							variant="outline"
						>
							<DownloadIcon class="size-4 mr-2" />
							Visit FFmpeg Download Page
						</Button>
					</div>
				{/if}
			{/if}
		</Card.Content>

		{#if ffmpegQuery.data !== true}
			<Card.Footer>
				<Link
					href="/settings/transcription"
					class={buttonVariants({ variant: 'outline', class: 'w-full' })}
				>
					Back to Settings
				</Link>
			</Card.Footer>
		{/if}
	</Card.Root>
</main>

<style>
	:global(.animate-spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>
