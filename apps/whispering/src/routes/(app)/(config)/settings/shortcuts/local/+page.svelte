<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/state/settings.svelte';
	import { resetLocalShortcuts } from '$routes/(app)/_layout-utils/register-commands';
	import ShortcutFormatHelp from '../keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from '../keyboard-shortcut-recorder/ShortcutTable.svelte';
</script>

<svelte:head> <title>Local Shortcuts - Whispering</title> </svelte:head>

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
					Local Shortcuts
				</SectionHeader.Title>
				<ShortcutFormatHelp type="local" />
			</div>
			<SectionHeader.Description>
				Set keyboard shortcuts that work when the app is in focus. These
				shortcuts will only trigger when Whispering is the active application.
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button
			variant="outline"
			size="sm"
			disabled={!settings.get('shortcuts.local.enabled')}
			onclick={() => {
				resetLocalShortcuts();
				rpc.notify.success({
					title: 'Shortcuts reset',
					description: 'All local shortcuts have been reset to defaults.',
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
			<Label for="local-shortcuts-toggle" class="text-base font-medium">
				Enable local shortcuts
			</Label>
			<p class="text-sm text-muted-foreground">
				Off by default. Most users only need global shortcuts; the local
				listener can interfere with recording new global combos.
			</p>
		</div>
		<Switch
			id="local-shortcuts-toggle"
			bind:checked={
				() => settings.get('shortcuts.local.enabled'),
				(checked) => settings.set('shortcuts.local.enabled', checked)
			}
			class="shrink-0"
		/>
	</div>

	<div
		class={settings.get('shortcuts.local.enabled')
			? ''
			: 'pointer-events-none opacity-50'}
		aria-disabled={!settings.get('shortcuts.local.enabled')}
	>
		<ShortcutTable type="local" />
	</div>
</section>
