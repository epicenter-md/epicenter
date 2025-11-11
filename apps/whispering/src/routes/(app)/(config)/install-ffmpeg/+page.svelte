<script lang="ts">
	import { Button, buttonVariants } from '@repo/ui/button';
	import { Link } from '@repo/ui/link';
	import * as Card from '@repo/ui/card';
	import * as Alert from '@repo/ui/alert';
	import * as Tabs from '@repo/ui/tabs';
	import { Snippet } from '@repo/ui/snippet';
	import { Badge } from '@repo/ui/badge';
	import {
		DownloadIcon,
		CheckCircleIcon,
		XCircleIcon,
		LoaderIcon,
		RefreshCwIcon,
		ExternalLinkIcon,
		ArrowLeftIcon,
	} from '@lucide/svelte';
	import * as services from '$lib/services';
	import { goto } from '$app/navigation';
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	const platform = services.os.type();

	const ffmpegQuery = createQuery(() => ({
		...rpc.ffmpeg.checkFfmpegInstalled.options(),
		refetchInterval: (query) => {
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

<main class="flex flex-1 items-center justify-center p-8">
	<div class="w-full min-w-[640px] max-w-4xl">
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div class="space-y-3 flex-1 pr-8">
						<Card.Title class="text-3xl">Install FFmpeg</Card.Title>
						<Card.Description class="text-base leading-relaxed">
							FFmpeg converts audio to WAV format for local transcription and
							compresses files for efficient cloud API transmission.
						</Card.Description>
					</div>

					<div class="flex flex-col items-end gap-3">
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

			<Card.Content class="space-y-8">
				{#if ffmpegQuery.data === true}
					<Alert.Root class="border-green-500/20 bg-green-500/5">
						<CheckCircleIcon
							class="size-4 text-green-600 dark:text-green-400"
						/>
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
					<Tabs.Root value={platform}>
						<Tabs.List class="grid w-full grid-cols-3">
							<Tabs.Trigger value="macos">macOS</Tabs.Trigger>
							<Tabs.Trigger value="windows">Windows</Tabs.Trigger>
							<Tabs.Trigger value="linux">Linux</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="macos" class="mt-6">
							<div class="space-y-6">
								<h3 class="text-lg font-semibold">macOS Installation</h3>

								<div class="space-y-3">
									<p class="text-sm font-medium">
										Install using Homebrew (supports both Intel and Apple
										Silicon)
									</p>
									<Snippet text="brew install ffmpeg" />

									<p class="text-xs text-muted-foreground">
										Don't have Homebrew?
										<Link
											href="https://brew.sh"
											target="_blank"
											rel="noopener noreferrer"
											class="underline"
										>
											Install it from brew.sh
										</Link>
									</p>
								</div>

								<div class="border-t pt-4">
									<p class="text-sm font-medium mb-2">Verify Installation</p>
									<p class="text-sm text-muted-foreground mb-2">
										After installation, verify FFmpeg is working:
									</p>
									<Snippet text="ffmpeg -version" variant="secondary" />
								</div>
							</div>
						</Tabs.Content>

						<Tabs.Content value="windows" class="mt-6">
							<div class="space-y-8">
								<!-- Windows Installation Section -->
								<div class="space-y-6">
									<div class="space-y-2">
										<h3 class="text-lg font-semibold">Windows Installation</h3>
									</div>

									<ol class="space-y-6 text-sm text-muted-foreground">
										<li class="flex gap-4">
											<span class="font-semibold text-foreground shrink-0"
												>1.</span
											>
											<div class="space-y-3 flex-1">
												<p>Download FFmpeg from GitHub:</p>
												<Button
													href="https://github.com/BtbN/FFmpeg-Builds/releases"
													target="_blank"
													rel="noopener noreferrer"
													variant="default"
													size="lg"
													class="w-full sm:w-auto"
												>
													<DownloadIcon class="size-5 mr-2" />
													Download FFmpeg for Windows
												</Button>
											</div>
										</li>

										<li class="flex gap-4">
											<span class="font-semibold text-foreground shrink-0"
												>2.</span
											>
											<div class="space-y-2 flex-1">
												<p>
													Download the latest <code
														class="bg-muted px-2 py-1 rounded text-xs font-mono"
														>ffmpeg-master-latest-win64-gpl-shared.zip</code
													>
												</p>
											</div>
										</li>

										<li class="flex gap-4">
											<span class="font-semibold text-foreground shrink-0"
												>3.</span
											>
											<div class="space-y-2 flex-1">
												<p>
													Extract the ZIP file to <code
														class="bg-muted px-2 py-1 rounded text-xs font-mono"
														>C:\ffmpeg</code
													>
												</p>
											</div>
										</li>

										<li class="flex gap-4">
											<span class="font-semibold text-foreground shrink-0"
												>4.</span
											>
											<div class="space-y-6 flex-1">
												<p>
													Add <code
														class="bg-muted px-2 py-1 rounded text-xs font-mono"
														>C:\ffmpeg\bin</code
													> to your Windows PATH:
												</p>

												<!-- Method 1 -->
												<div class="space-y-4 border-l-2 border-muted pl-6">
													<p class="text-base font-semibold text-foreground">
														Method 1: Using Windows Settings (Recommended)
													</p>
													<ol class="space-y-3 text-sm text-muted-foreground">
														<li class="flex gap-3">
															<span class="shrink-0">a.</span>
															<span
																>Press <kbd
																	class="bg-muted px-2 py-1 rounded font-mono text-xs"
																	>Windows + X</kbd
																> and select "System"</span
															>
														</li>
														<li class="flex gap-3">
															<span class="shrink-0">b.</span>
															<span
																>Click "Advanced system settings" → "Environment
																Variables..."</span
															>
														</li>
														<li class="flex gap-3">
															<span class="shrink-0">c.</span>
															<span
																>Under "System variables", select "Path" →
																"Edit..." → "New"</span
															>
														</li>
														<li class="flex gap-3">
															<span class="shrink-0">d.</span>
															<span
																>Add: <code
																	class="bg-muted px-2 py-1 rounded font-mono text-xs"
																	>C:\ffmpeg\bin</code
																></span
															>
														</li>
														<li class="flex gap-3">
															<span class="shrink-0">e.</span>
															<span>Click "OK" on all dialogs</span>
														</li>
													</ol>
												</div>

												<!-- Method 2 -->
												<div class="space-y-4 border-l-2 border-muted pl-6">
													<p class="text-base font-semibold text-foreground">
														Method 2: PowerShell (One Command)
													</p>
													<div class="space-y-3">
														<Snippet
															text="[Environment]::SetEnvironmentVariable(&quot;Path&quot;, $env:Path + &quot;;C:\ffmpeg\bin&quot;, &quot;Machine&quot;)"
														/>
														<p class="text-xs text-muted-foreground">
															<strong>Note:</strong> Run PowerShell as Administrator
															for this command
														</p>
													</div>
												</div>

												<!-- Video Tutorial -->
												<div
													class="border rounded-lg p-4 bg-muted/20 space-y-3"
												>
													<p class="text-sm font-medium">
														📹 Need help with PATH setup?
													</p>
													<Button
														href="https://www.youtube.com/watch?v=eRZRXpzZfM4&t=85s"
														target="_blank"
														rel="noopener noreferrer"
														variant="outline"
														size="sm"
													>
														<ExternalLinkIcon class="size-3 mr-2" />
														Watch Tutorial Video
													</Button>
												</div>
											</div>
										</li>
										<li class="flex gap-4">
											<span class="font-semibold text-foreground shrink-0"
												>5.</span
											>
											<div class="space-y-3 flex-1">
												<p class="text-sm text-muted-foreground">
													Restart Whispering, then verify FFmpeg is working:
												</p>
												<Snippet text="ffmpeg -version" variant="secondary" />
											</div>
										</li>
									</ol>
								</div>

								<!-- Troubleshooting Section -->
								<div class="space-y-6 border-t pt-8">
									<h3 class="text-lg font-semibold">Troubleshooting</h3>

									<div class="space-y-5">
										<div class="p-5 border rounded-lg bg-muted/10 space-y-4">
											<p class="text-base font-semibold">
												🚫 "ffmpeg is not recognized as an internal or external
												command"
											</p>
											<ul
												class="space-y-3 ml-4 list-disc text-sm text-muted-foreground"
											>
												<li>
													Make sure you added <code
														class="bg-muted px-2 py-1 rounded font-mono text-xs"
														>C:\ffmpeg\bin</code
													>
													to PATH (not just
													<code
														class="bg-muted px-2 py-1 rounded font-mono text-xs"
														>C:\ffmpeg</code
													>)
												</li>
												<li>
													Restart Whispering completely after adding to PATH
												</li>
												<li>
													Test in a new Command Prompt: <code
														class="bg-muted px-2 py-1 rounded font-mono text-xs"
														>ffmpeg -version</code
													>
												</li>
											</ul>
										</div>

										<details class="border rounded-lg">
											<summary
												class="p-4 cursor-pointer hover:bg-muted/5 text-base font-semibold"
											>
												🔧 Advanced Troubleshooting
											</summary>
											<div class="px-5 pb-5 space-y-4 border-t bg-muted/5 pt-4">
												<ul
													class="space-y-3 ml-4 list-disc text-sm text-muted-foreground"
												>
													<li>
														Log out and back into Windows to refresh environment
														variables
													</li>
													<li>Check if Windows Defender is blocking FFmpeg</li>
													<li>
														Verify the ffmpeg.exe file exists at <code
															class="bg-muted px-2 py-1 rounded font-mono text-xs"
															>C:\ffmpeg\bin\ffmpeg.exe</code
														>
													</li>
												</ul>
											</div>
										</details>
									</div>
								</div>
							</div>
						</Tabs.Content>

						<Tabs.Content value="linux" class="mt-6">
							<div class="space-y-4">
								<h3 class="text-lg font-semibold">Linux Installation</h3>

								<div class="space-y-4">
									<div>
										<p class="text-sm font-medium mb-2">Ubuntu/Debian:</p>
										<Snippet
											text="sudo apt update && sudo apt install ffmpeg"
										/>
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

								<div class="border-t pt-4">
									<p class="text-sm font-medium mb-2">Verify Installation</p>
									<p class="text-sm text-muted-foreground mb-2">
										After installation, verify FFmpeg is working by running this
										command:
									</p>
									<Snippet text="ffmpeg -version" variant="secondary" />
								</div>
							</div>
						</Tabs.Content>
					</Tabs.Root>
				{/if}
			</Card.Content>

			{#if ffmpegQuery.data !== true}
				<Card.Footer class="flex justify-center">
					<Button href="/settings/transcription" variant="ghost" size="sm">
						<ArrowLeftIcon class="size-4 mr-2" />
						Back to Settings
					</Button>
				</Card.Footer>
			{/if}
		</Card.Root>
	</div>
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
