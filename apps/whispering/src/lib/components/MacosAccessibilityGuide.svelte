<script lang="ts">
	import type { Snippet } from 'svelte';

	// Single source of the macOS Accessibility instructions, embedded in the global
	// `MacosAccessibilityGuideDialog`. Kept as one component so any surface can embed
	// the same instructions instead of restating them.
	//
	// The steps branch on `variant` because the two situations need genuinely
	// different actions, and showing the wrong one is worse than terse:
	//   - `first-grant` (never granted): `openSystemSettings` already adds Epicenter
	//     to the list toggled off, so the whole job is flipping its switch. Telling a
	//     brand-new user to "remove Epicenter" is impossible: it isn't there yet.
	//   - `re-add` (stale grant after an app update): the toggle reads on but paste
	//     at cursor is dead, and only a remove-and-re-add clears it.
	// Neither variant repeats "navigate to Accessibility": the dialog's Open System
	// Settings button deep-links there, so the steps describe what to do once you land.
	let { variant }: { variant: 'first-grant' | 're-add' } = $props();
</script>

<ol class="flex flex-col gap-3">
	{#snippet step(number: number, body: Snippet)}
		<li class="flex items-start gap-3">
			<span
				class="bg-muted text-foreground mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums"
				aria-hidden="true"
			>
				{number}
			</span>
			<span class="text-muted-foreground text-sm leading-relaxed">
				{@render body()}
			</span>
		</li>
	{/snippet}

	{#if variant === 're-add'}
		{@render step(1, removeEpicenter)}
		{@render step(2, readdEpicenter)}
	{:else}
		{@render step(1, findEpicenter)}
		{@render step(2, switchOn)}
	{/if}
</ol>

{#snippet term(text: string)}
	<span class="text-foreground font-medium">{text}</span>
{/snippet}

{#snippet control(symbol: string)}
	<!-- A clicked on-screen button in System Settings, not a keystroke, so a chip
	     rather than <kbd>. -->
	<span
		class="bg-muted text-foreground inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 align-text-bottom text-xs font-medium"
	>
		{symbol}
	</span>
{/snippet}

{#snippet findEpicenter()}
	Find {@render term('Epicenter')} in the list (we added it for you).
{/snippet}

{#snippet switchOn()}
	Switch it {@render term('on')}.
{/snippet}

{#snippet removeEpicenter()}
	Click {@render term('Epicenter')}, then remove it with the {@render control(
		'−',
	)} button.
{/snippet}

{#snippet readdEpicenter()}
	Press the {@render control('+')} button and re-add {@render term(
		'Epicenter.app',
	)}.
{/snippet}
