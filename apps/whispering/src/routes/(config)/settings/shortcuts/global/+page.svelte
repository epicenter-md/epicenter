<script lang="ts">
	import { Button, buttonVariants } from '@repo/ui/button';
	import { Link } from '@repo/ui/link';
	import { Separator } from '@repo/ui/separator';
	import { rpc } from '$lib/query';
	import { Layers2Icon, RotateCcw } from '@lucide/svelte';
	import ShortcutFormatHelp from '../keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from '../keyboard-shortcut-recorder/ShortcutTable.svelte';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<svelte:head>
	<title>Global Shortcuts - Whispering</title>
</svelte:head>

{#if window.__TAURI_INTERNALS__}
	<section>
		<div
			class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
		>
			<header class="space-y-1">
				<div class="flex items-center gap-2">
					<h2 class="text-xl font-semibold tracking-tight sm:text-2xl">
						Global Shortcuts
					</h2>
					<ShortcutFormatHelp type="global" />
				</div>
				<p class="text-sm text-muted-foreground">
					Set system-wide keyboard shortcuts that work even when Whispering is
					not in focus. These shortcuts will trigger from anywhere on your
					system.
				</p>
			</header>
			<Button
				variant="outline"
				size="sm"
				onclick={() => {
					settings.resetGlobalShortcuts();
					rpc.notify.success.execute({
						title: 'Shortcuts reset',
						description: 'All global shortcuts have been reset to defaults.',
					});
				}}
				class="shrink-0"
			>
				<RotateCcw class="mr-2 size-4" />
				Reset to defaults
			</Button>
		</div>

		<Separator class="my-6" />

		<ShortcutTable type="global" />
	</section>
{:else}
	<div class="rounded-lg border bg-card text-card-foreground shadow-sm">
		<div class="flex flex-col items-center justify-center p-8 text-center">
			<Layers2Icon class="mb-4 size-10 text-muted-foreground" />
			<h3 class="mb-2 text-xl font-medium">Global Shortcuts</h3>
			<p class="mb-6 max-w-md text-sm text-muted-foreground">
				Global shortcuts allow you to use Whispering from any application on
				your computer. This feature is only available in the desktop app or
				browser extension.
			</p>
			<Link href="/desktop-app" class={buttonVariants()}>
				Enable Global Shortcuts
			</Link>
		</div>
	</div>
{/if}
