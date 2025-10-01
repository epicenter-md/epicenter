<script lang="ts">
	import { Button } from '@repo/ui/button';
	import { Badge } from '@repo/ui/badge';
	import * as Card from '@repo/ui/card';
	import { SettingsIcon, CheckIcon, ArrowLeft } from '@lucide/svelte';
	import * as services from '$lib/services';
	import { toast } from 'svelte-sonner';
	import { Command } from '@tauri-apps/plugin-shell';
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';

	let { data } = $props();
	const isAccessibilityGranted = $derived(data.isAccessibilityGranted);

	async function requestPermissionOrShowGuidance() {
		const { error } = await services.permissions.accessibility.request();

		if (error) {
			toast.error('Failed to open accessibility settings', {
				description:
					'Please enable Accessibility in System Settings > Privacy & Security > Accessibility manually',
				action: {
					label: 'Open Accessibility Settings',
					onClick: () => openSystemSettings(),
				},
			});
		}
	}

	async function openSystemSettings() {
		try {
			// Try opening System Settings directly (works on macOS 13+)
			const command = Command.create('open', [
				'x-apple.systemsettings:com.apple.SystemSettings.extension',
			]);
			await command.execute();

			// Show helpful toast since we can't open directly to accessibility
			toast.info('System Settings Opened', {
				description:
					'Navigate to Privacy & Security > Accessibility to grant permissions.',
				duration: 8000,
			});
		} catch (error) {
			console.error('Failed to open System Settings:', error);

			// Fallback: Show detailed instructions
			toast.info('Open System Settings Manually', {
				description:
					'Click Apple menu → System Settings → Privacy & Security → Accessibility',
				duration: 10000,
			});
		}
	}
</script>

<svelte:head>
	<title>MacOS Accessibility</title>
</svelte:head>

<main class="flex flex-1 items-center justify-center">
	<Card.Root class="w-full max-w-2xl">
		<Card.Header>
			<Card.Title class="text-xl">MacOS Accessibility</Card.Title>
			<Card.Description class="leading-7">
				Follow the steps below to re-enable Whispering in your macOS Accessibility settings. 
				This often is needed after installing new versions of Whispering due to a macOS bug.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-col items-center gap-2">
				{#if window.__TAURI_INTERNALS__}
					<!-- YouTube embed for Tauri app (external videos don't work well) -->
					<iframe
						class="max-w-md rounded-lg border"
						width="560"
						height="315"
						src="https://www.youtube.com/embed/FJRktNkr1Fs"
						title="macOS Accessibility Settings Guide"
						frameborder="0"
						allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
						allowfullscreen
					></iframe>
				{:else}
					<!-- Direct video for web version -->
					<video
						class="max-w-md rounded-lg border"
						src="https://github.com/epicenter-so/epicenter/releases/download/_assets/macos_enable_accessibility.mp4"
						autoplay
						loop
						controls
						muted
						playsinline
					>
						<p class="text-muted-foreground text-sm">
							Video guide not available. Please follow the written instructions
							below.
						</p>
					</video>
				{/if}
				<ol
					class="text-muted-foreground list-inside list-decimal space-y-1 text-sm leading-7"
				>
					<li>
						Go to <span class="text-primary font-semibold tracking-tight">
							System Settings > Privacy & Security > Accessibility
						</span> or click the button below.
					</li>

					<li>
						Click on <span class="text-primary font-semibold tracking-tight"
							>🎙️ Whispering</span
						> and remove it using the minus icon (-).
					</li>
					<li>
						Re-add Whispering by pressing the plus icon (+) and selecting <span
							class="text-primary font-semibold tracking-tight"
							>🎙️ Whispering.app</span
						>
					</li>
				</ol>
			</div>
		</Card.Content>
		<Card.Footer>
			{#if !isAccessibilityGranted}
				<div class="flex gap-3 w-full">
					<Button
						variant="outline"
						onclick={() => goto('/')}
						class="flex-1 text-sm"
					>
						<ArrowLeft class="mr-2 size-4" />
						Back to Home
					</Button>
					<Button
						onclick={() => requestPermissionOrShowGuidance()}
						class="flex-1 text-sm"
					>
						<SettingsIcon class="mr-2 size-4" />
						Request Permission
					</Button>
				</div>
			{:else}
				<div class="flex flex-col gap-3 w-full">
					<Badge variant="success">
						<CheckIcon class="size-4" />
						Accessibility permissions granted
					</Badge>
					<div class="flex gap-3">
						<Button
							variant="outline"
							onclick={() => goto('/')}
							class="flex-1 text-sm"
						>
							<ArrowLeft class="mr-2 size-4" />
							Back to Home
						</Button>
						<Button
							onclick={() => openSystemSettings()}
							variant="outline"
							class="flex-1 text-sm"
						>
							<SettingsIcon class="mr-2 size-4" />
							Open Settings
						</Button>
					</div>
				</div>
			{/if}
		</Card.Footer>
	</Card.Root>
</main>
