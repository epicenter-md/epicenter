<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LockIcon from '@lucide/svelte/icons/lock';
	import {
		clipboardFallback,
		pasteBack,
	} from '$lib/components/accessibility-feature-copy';
	import { openSystemSettings } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { SettingSwitch } from '$lib/components/settings';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import type { BooleanSettingKey } from '$lib/state/settings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { tauri } from '#platform/tauri';

	// One scope's full output delivery UI: copy to clipboard, paste at cursor (with
	// its macOS Accessibility notice), and the dependent "press Enter" sub-toggle.
	// These three always travel together because delivery.ts routes both the
	// transcription and recipe scopes through the same path (clipboard, then a
	// synthetic Cmd+V for cursor, then Enter), so the same trio and the same
	// Accessibility caveat apply to both. Driving every surface (the two Settings
	// output groups and the home capture popover) from this one component keeps the
	// labels, the remediation copy, and the gating from ever drifting.
	//
	// Scope is the only axis that varies: the keys are `output.<scope>.*` and every
	// label is the scope's noun plugged into one phrasing, so a label change happens
	// in exactly one place. Paste-at-cursor stays interactive without the grant (it
	// records intent); the capability recheck on window focus starts the paste the
	// moment Accessibility lands, with no second visit to flip it back on.
	type OutputScope = 'transcription' | 'recipe';
	let { scope }: { scope: OutputScope } = $props();

	const SCOPES = {
		transcription: {
			noun: 'transcript',
			clipboard: 'output.transcription.clipboard',
			cursor: 'output.transcription.cursor',
			enter: 'output.transcription.enter',
		},
		recipe: {
			noun: 'recipe output',
			clipboard: 'output.recipe.clipboard',
			cursor: 'output.recipe.cursor',
			enter: 'output.recipe.enter',
		},
	} satisfies Record<
		OutputScope,
		{
			noun: string;
			clipboard: BooleanSettingKey;
			cursor: BooleanSettingKey;
			enter: BooleanSettingKey;
		}
	>;
	const delivery = $derived(SCOPES[scope]);
</script>

<SettingSwitch
	key={delivery.clipboard}
	label={`Copy ${delivery.noun} to clipboard`}
/>

<SettingSwitch key={delivery.cursor} label={`Paste ${delivery.noun} at cursor`} />

{#if tauri && dictationCapability.isUnavailable}
	<!-- The toggle stays on and interactive (it records intent), but the paste
	can't fire without the macOS Accessibility grant. Annotate the current
	capability inline; offer the grant only when there is one to give (untrusted
	or stale, not Wayland). -->
	<div
		class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
	>
		<LockIcon class="size-3.5 shrink-0" aria-hidden="true" />
		<span>{pasteBack} {clipboardFallback}</span>
		{#if dictationCapability.needsAccessibility}
			<Button
				variant="link"
				class="h-auto p-0 text-sm font-normal"
				onclick={openSystemSettings}
			>
				Open Settings
			</Button>
		{/if}
	</div>
{/if}

{#if tauri && settings.get(delivery.cursor)}
	<div class:opacity-50={dictationCapability.isUnavailable}>
		<SettingSwitch
			key={delivery.enter}
			label={`Press Enter after pasting ${delivery.noun}`}
		/>
	</div>
{/if}
