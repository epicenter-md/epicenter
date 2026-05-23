<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Label } from '@epicenter/ui/label';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import Layers2Icon from '@lucide/svelte/icons/layers-2';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { rpc } from '$lib/query';
	import { desktopRpc } from '$lib/query/desktop';
	import { settings } from '$lib/state/settings.svelte';
	import { resetGlobalShortcuts } from '$routes/(app)/_layout-utils/register-commands';
	import ShortcutFormatHelp from '../keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from '../keyboard-shortcut-recorder/ShortcutTable.svelte';
</script>

<svelte:head> <title>Global Shortcuts - Whispering</title> </svelte:head>

{#if window.__TAURI_INTERNALS__}
	<section>
		<div
			class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
		>
			<SectionHeader.Root>
				<div class="flex items-center gap-2">
					<SectionHeader.Title
						level={2}
						class="text-xl tracking-tight sm:text-2xl"
					>
						Global Shortcuts
					</SectionHeader.Title>
					<ShortcutFormatHelp type="global" />
				</div>
				<SectionHeader.Description>
					Set system-wide keyboard shortcuts that work even when Whispering is
					not in focus. These shortcuts will trigger from anywhere on your
					system.
				</SectionHeader.Description>
			</SectionHeader.Root>
			<Button
				variant="outline"
				size="sm"
				disabled={!settings.get('shortcuts.global.enabled')}
				onclick={async () => {
					await desktopRpc.globalShortcuts.unregisterAll();
					resetGlobalShortcuts();
					rpc.notify.success({
						title: 'Shortcuts reset',
						description: 'All global shortcuts have been reset to defaults.',
					});
				}}
				class="shrink-0"
			>
				<RotateCcw class="size-4" />
				Reset to defaults
			</Button>
		</div>

		<Separator class="my-6" />

		<div class="mb-6 flex items-start justify-between gap-4 rounded-md border p-4">
			<div class="space-y-1">
				<Label for="global-shortcuts-toggle" class="text-base font-medium">
					Enable global shortcuts
				</Label>
				<p class="text-sm text-muted-foreground">
					On by default. Turn off to free all configured combos system-wide
					(your settings stay; flipping back on restores them).
				</p>
			</div>
			<Switch
				id="global-shortcuts-toggle"
				bind:checked={
					() => settings.get('shortcuts.global.enabled'),
					(checked) => settings.set('shortcuts.global.enabled', checked)
				}
				class="shrink-0"
			/>
		</div>

		<div
			class={settings.get('shortcuts.global.enabled')
				? ''
				: 'pointer-events-none opacity-50'}
			aria-disabled={!settings.get('shortcuts.global.enabled')}
		>
			<ShortcutTable type="global" />
		</div>
	</section>
{:else}
	<Empty.Root>
		<Empty.Header>
			<Empty.Media>
				<Layers2Icon class="size-10 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Global Shortcuts</Empty.Title>
			<Empty.Description>
				Global shortcuts allow you to use Whispering from any application on
				your computer. This feature is only available in the desktop app or
				browser extension.
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Link href="/desktop-app" class={buttonVariants()}>
				Enable Global Shortcuts
			</Link>
		</Empty.Content>
	</Empty.Root>
{/if}
