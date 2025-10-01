<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { ChromeWebStoreIcon } from '$lib/components/icons';
	import { Button } from '@repo/ui/button';
	import { Card } from '@repo/ui/card';
	import { CommandIcon, DownloadIcon, MicIcon, ZapIcon } from '@lucide/svelte';
</script>

<svelte:head>
	<title>Download Desktop App - Whispering</title>
</svelte:head>

<main
	class="flex flex-1 items-center justify-center p-4 container max-w-4xl mx-auto"
>
	<div class="w-full">
		<header class="text-center space-y-4 mb-8">
			<h1 class="scroll-m-20 text-4xl font-bold tracking-tight lg:text-5xl">
				Whispering Desktop
			</h1>
			<p class="text-muted-foreground text-lg lg:text-xl max-w-2xl mx-auto">
				Experience the full power of Whispering with native performance and
				system-wide integration.
			</p>
		</header>

		<div class="grid gap-6 mb-8 lg:grid-cols-3">
			<Card class="p-6">
				<div class="space-y-2">
					<CommandIcon class="h-8 w-8 text-primary mb-2" />
					<h3 class="text-lg font-semibold">Global Shortcuts</h3>
					<p class="text-sm text-muted-foreground">
						Customizable global keyboard shortcuts for recording control from
						anywhere on your system
					</p>
				</div>
			</Card>

			<Card class="p-6">
				<div class="space-y-2">
					<MicIcon class="h-8 w-8 text-primary mb-2" />
					<h3 class="text-lg font-semibold">Native Performance</h3>
					<p class="text-sm text-muted-foreground">
						Rust backend, more audio APIs, and optimized resource usage
					</p>
				</div>
			</Card>

			<Card class="p-6">
				<div class="space-y-2">
					<ZapIcon class="h-8 w-8 text-primary mb-2" />
					<h3 class="text-lg font-semibold">System Integration</h3>
					<p class="text-sm text-muted-foreground">
						System tray controls, direct text injection, auto-updates, and
						window management
					</p>
				</div>
			</Card>
		</div>

		<div class="flex flex-col items-center gap-4">
			<div class="flex flex-col gap-3 sm:flex-row">
				<WhisperingButton
					tooltipContent="Download Whispering Desktop App"
					href="https://github.com/epicenter-md/epicenter/releases"
					target="_blank"
					rel="noopener noreferrer"
					variant="default"
					size="lg"
					class="min-w-[200px]"
				>
					<DownloadIcon class="mr-2 size-5" />
					Download for Desktop
				</WhisperingButton>
				<WhisperingButton
					tooltipContent="Get the Chrome Extension"
					href="https://chromewebstore.google.com/detail/whispering/oilbfihknpdbpfkcncojikmooipnlglo"
					target="_blank"
					rel="noopener noreferrer"
					variant="outline"
					size="lg"
				>
					<ChromeWebStoreIcon class="mr-2 size-5" />
					Chrome Extension
				</WhisperingButton>
			</div>

			<Button onclick={() => window.history.back()} variant="link" class="mt-2">
				Go back
			</Button>
		</div>
	</div>
</main>
