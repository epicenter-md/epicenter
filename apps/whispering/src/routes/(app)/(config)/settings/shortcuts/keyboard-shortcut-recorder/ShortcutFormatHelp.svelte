<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import * as Alert from '@repo/ui/alert';
	import { Badge } from '@repo/ui/badge';
	import { Button } from '@repo/ui/button';
	import * as Dialog from '@repo/ui/dialog';
	import * as Tooltip from '@repo/ui/tooltip';
	import {
		ACCELERATOR_SECTIONS,
		CommandOrAlt,
		CommandOrControl,
		KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS,
		OPTION_DEAD_KEYS,
	} from '$lib/constants/keyboard';
	import { IS_MACOS } from '$lib/constants/platform';
	import { AlertTriangle, ExternalLink, HelpCircle } from '@lucide/svelte';

	let { type }: { type: 'local' | 'global' } = $props();
	let dialogOpen = $state(false);

	const isLocal = $derived(type === 'local');

	/**
	 * Examples for each shortcut type
	 */
	const SHORTCUT_EXAMPLES = {
		local: [
			' ',
			`${CommandOrControl.toLowerCase()}+a`,
			`${CommandOrControl.toLowerCase()}+shift+p`,
			`${CommandOrAlt.toLowerCase()}+s`,
			'f5',
			`control+${CommandOrAlt.toLowerCase()}+delete`,
		],
		global: [
			'Space',
			'Control+A',
			`${CommandOrControl}+Shift+P`,
			`${CommandOrAlt}+S`,
			'F5',
			`Control+${CommandOrAlt}+Delete`,
		],
	} as const;
</script>

<WhisperingButton
	variant="ghost"
	size="icon"
	class="size-6"
	onclick={() => (dialogOpen = true)}
	tooltipContent="Click for shortcut format guide"
>
	<HelpCircle class="size-4" />
	<span class="sr-only">Shortcut format help</span>
</WhisperingButton>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-3xl">
		<Dialog.Header>
			<Dialog.Title>
				{isLocal ? 'Local' : 'Global'} Shortcut Format Guide
			</Dialog.Title>
			<Dialog.Description>
				Learn how to format keyboard shortcuts for {isLocal
					? 'in-app'
					: 'system-wide'} use.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4">
			<!-- Quick format summary -->
			<div class="rounded-lg bg-muted p-4">
				<p class="text-sm">
					Use <code class="font-mono text-xs">modifier+key</code> format or just
					<code class="font-mono text-xs">key</code> for single keys.
				</p>
				{#if isLocal}
					<p class="text-sm text-muted-foreground mt-1">
						Any key from your keyboard can be used (lowercase). Below are common
						examples:
					</p>
				{/if}
			</div>

			<!-- Two-column flex layout -->
			<div class="flex flex-col sm:flex-row sm:divide-x">
				<!-- Left column: Modifiers -->
				<div class="sm:pr-4">
					<h4 class="text-sm font-semibold mb-1">Modifiers</h4>
					<p class="text-xs text-muted-foreground mb-2">Hold with other keys</p>
					<div class="flex flex-wrap sm:flex-col gap-1">
						{#each (isLocal ? KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS.at(0) : ACCELERATOR_SECTIONS.at(0)).keys as modifier}
							<Badge variant="outline" class="font-mono text-sm justify-start">
								{modifier}
							</Badge>
						{/each}
					</div>
				</div>

				<!-- Right column: All other keys -->
				<div class="flex-1 sm:pl-4">
					<div class="flex flex-col gap-4">
						{#each (isLocal ? KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS : ACCELERATOR_SECTIONS).slice(1) as section}
							<div>
								<h4 class="text-sm font-semibold mb-1">{section.title}</h4>
								<p class="text-xs text-muted-foreground mb-2">
									{section.description}
								</p>
								<div class="flex flex-wrap gap-1">
									{#each section.keys as key}
										<Badge variant="secondary" class="font-mono text-xs">
											{key}
										</Badge>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>

			<!-- Examples -->
			<div>
				<h4 class="mb-2 font-medium">Examples</h4>
				<div class="space-y-2 rounded-lg border p-3">
					{#each SHORTCUT_EXAMPLES[isLocal ? 'local' : 'global'] as example}
						<code class="block text-sm">{example}</code>
					{/each}
				</div>
			</div>

			{#if IS_MACOS}
				<Alert.Root variant="warning">
					<AlertTriangle class="size-4" />
					<Alert.Title>macOS Option Key Limitations</Alert.Title>
					<Alert.Description class="space-y-2">
						<p>
							On macOS, certain Option (Alt) key combinations act as "dead keys"
							that don't register properly when recording:
						</p>
						<div class="flex flex-wrap gap-1 my-2">
							{#each OPTION_DEAD_KEYS as key}
								<Badge variant="outline" class="font-mono text-xs">
									Option+{key.toUpperCase()}
								</Badge>
							{/each}
						</div>
						<p class="font-medium">Workarounds:</p>
						<ul class="list-disc list-inside space-y-1 ml-2">
							<li>Record in reverse: Press the letter first, then Option</li>
							<li>Edit manually: Type "alt+e" instead of recording</li>
						</ul>
					</Alert.Description>
				</Alert.Root>
			{/if}
		</div>

		<Dialog.Footer>
			{#if !isLocal}
				<Button
					variant="outline"
					href="https://www.electronjs.org/docs/latest/api/accelerator"
					target="_blank"
					rel="noreferrer"
				>
					<ExternalLink class="mr-2 size-4" />
					View documentation
				</Button>
			{/if}
			<Button onclick={() => (dialogOpen = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
