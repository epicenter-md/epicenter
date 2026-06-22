<!--
	The universal first-run setup flow. Shown by home whenever transcription
	isn't ready (or we're mid-flow), first launch or a later regression alike:
	if you're here, something needs setting up, so the full guided flow is the
	helpful thing. No persisted "have they seen it" flag; home holds the flow
	open with ephemeral state and releases on completion.

	Value-first order: welcome (true first run only) -> engine -> first dictation
	(the aha; the mic prompt happens in-context here) -> dictate-anywhere upsell
	(macOS only; reuses the existing Accessibility guide and reads the live
	capability) -> done. The welcome is gated on a zero-recording first run; the
	Accessibility step is absent where it has no meaning (web, Linux Wayland) and
	adapts its content to the capability.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Item from '@epicenter/ui/item';
	import * as Kbd from '@epicenter/ui/kbd';
	import type { Component } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { MediaQuery } from 'svelte/reactivity';
	import { fade, fly, scale } from 'svelte/transition';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Cloud from '@lucide/svelte/icons/cloud';
	import Cpu from '@lucide/svelte/icons/cpu';
	import Heart from '@lucide/svelte/icons/heart';
	import Lock from '@lucide/svelte/icons/lock';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { TranscriptionRuntimeConfig } from '$lib/components/settings';
	import TranscriptionServiceSelect from '$lib/components/settings/TranscriptionServiceSelect.svelte';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { getTranscriptionReadiness } from '$lib/settings/transcription-validation';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import { tauri } from '#platform/tauri';
	import { createManualRecordingController } from './manual-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let { onComplete }: { onComplete: () => void } = $props();

	// True first run opens with a welcome + the three guarantees; a returning user
	// who hit a regression already has recordings and skips straight to setup.
	// Snapshot the count once at mount (a $state read, not a $derived) so the
	// welcome can't flash away as the Yjs table hydrates. Derived from recordings,
	// not a persisted "seen onboarding" flag, so it stays flag-free.
	const startedWithWelcome = recordings.sorted.length === 0;
	let showWelcome = $state(startedWithWelcome);
	const TRUST_POINTS = [
		{
			Icon: Lock,
			title: 'Private by default',
			description:
				'Local models keep your audio on this device. You decide if anything ever leaves.',
		},
		{
			Icon: Cpu,
			title: 'Runs on your device',
			description:
				'Local transcription works fully offline, with no account required.',
		},
		{
			Icon: Heart,
			title: 'Free and open source',
			description:
				'No subscription and no lock-in. Inspect it or self-host anything.',
		},
	] as const;

	const transcriptionReadiness = $derived(getTranscriptionReadiness());
	const engineReady = $derived(transcriptionReadiness.isReady);
	const shortcutLabel = $derived(getRecordingShortcutLabel('manual'));

	// The first decision that actually matters at first run: where transcription
	// runs. On device (local engines) vs Cloud (hosted API). Picking one snaps
	// `transcription.service` to that location's recommended default; the long
	// tail (other engines, other providers, self-hosted) stays behind "Use a
	// different service" below. Desktop only, since web has no local engine.
	const ENGINE_LOCATIONS = [
		{
			value: 'local',
			label: 'On device',
			description: 'Private and offline. Free, no account.',
			Icon: Cpu,
			recommended: true,
		},
		{
			value: 'cloud',
			label: 'Cloud',
			description: 'Fastest setup. Needs an API key.',
			Icon: Cloud,
			recommended: false,
		},
	] as const;
	const currentLocation = $derived(
		PROVIDERS[settings.get('transcription.service')].location,
	);
	function chooseLocation(location: 'local' | 'cloud') {
		// Already in this location? Keep the user's specific pick (a non-Parakeet
		// engine, a non-default provider) instead of snapping back to the default.
		if (currentLocation === location) return;
		settings.set(
			'transcription.service',
			location === 'local' ? 'parakeet' : 'OpenAI',
		);
	}

	// The Accessibility step exists only where it has meaning: a desktop build
	// that can tap the keyboard at all (not web, not Linux Wayland). Whether the
	// grant is present changes the step's CONTENT, not its existence, so granting
	// mid-step can't make the step vanish.
	const includeAccess = $derived(
		Boolean(tauri) && !dictationCapability.isUnsupported,
	);
	const steps = $derived([
		{ key: 'engine', label: 'Voice engine' },
		{ key: 'try', label: 'First dictation' },
		...(includeAccess
			? [{ key: 'access', label: 'Dictate anywhere' } as const]
			: []),
	] as const);

	let stepIndex = $state(0);
	let done = $state(false);
	const current = $derived(steps[Math.min(stepIndex, steps.length - 1)]);
	const isLastStep = $derived(stepIndex >= steps.length - 1);
	const transitionKey = $derived(done ? 'done' : (current?.key ?? 'engine'));

	const reduceMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	const flyIn = $derived(
		reduceMotion.current
			? { duration: 0 }
			: { y: 12, duration: 240, easing: cubicOut },
	);
	const popIn = $derived(
		reduceMotion.current
			? { duration: 0 }
			: { start: 0.96, duration: 220, easing: cubicOut },
	);
	// The wizard fades in as the welcome leaves, so "Get started" reads as a soft
	// hand-off rather than a hard cut. No out-transition on the welcome itself, so
	// the two screens never stack and shift the centered layout.
	const fadeIn = $derived(
		reduceMotion.current ? { duration: 0 } : { duration: 200, easing: cubicOut },
	);

	// First dictation rehearses the real recorder: the same controller and the same
	// RecordingActionCard the home screen uses, so the button and its live states
	// (start spinner, recording treatment) are honest rather than a bespoke mock.
	const rec = createManualRecordingController();
	// The practice transcript is just the latest recording's text, surfaced once
	// the controller's stop has resolved. Derived, not an effect-latch: stop awaits
	// the whole pipeline, so by the time `justRecorded` flips the row is already
	// saved, and computing it synchronously avoids a one-frame flash.
	const practiceTranscript = $derived(
		rec.justRecorded && !rec.isRecording
			? (recordings.sorted[0]?.transcript?.trim() ?? '')
			: '',
	);

	const requiredSatisfied = $derived(
		current?.key === 'engine' ? engineReady : true,
	);

	function statusOf(i: number) {
		if (done) return 'done';
		if (i > stepIndex) return 'future';
		if (i === stepIndex) return 'current';
		return 'done';
	}
	function next() {
		if (isLastStep) {
			done = true;
			return;
		}
		stepIndex += 1;
	}
	function back() {
		if (done) {
			done = false;
			return;
		}
		// At the first numbered step, Back returns to the welcome that opened the
		// flow rather than dead-ending. A returning user who never saw a welcome has
		// nothing behind step one, so Back stays disabled for them.
		if (stepIndex === 0) {
			if (startedWithWelcome) showWelcome = true;
			return;
		}
		stepIndex -= 1;
	}

	let bodyEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		showWelcome;
		stepIndex;
		done;
		bodyEl?.focus();
	});
</script>

{#snippet panelHead(Icon: Component, title: string, desc: string)}
	<div
		class="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary"
	>
		<Icon class="size-5" />
	</div>
	<div class="space-y-1.5">
		<h2 class="text-xl font-semibold tracking-tight text-balance">{title}</h2>
		<p
			class="mx-auto max-w-sm text-sm leading-relaxed text-pretty text-muted-foreground"
		>
			{desc}
		</p>
	</div>
{/snippet}

<div
	class="flex flex-1 flex-col items-center justify-center w-full px-4 py-12 sm:py-16"
>
	{#if showWelcome}
		<!--
			Welcome step, true first run only (no recordings yet). A brand moment plus
			the three guarantees before any setup. "Get started" drops into the
			numbered flow; it is a pre-step, so it carries no progress header of its own.
		-->
		<div
			class="flex w-full max-w-md flex-col items-center gap-8"
			in:fly={flyIn}
		>
			<div class="flex flex-col items-center gap-4 text-center">
				<img src={studioMicrophone} alt="" class="size-16" />
				<div class="space-y-2">
					<h2 class="text-2xl font-semibold tracking-tight text-balance">
						Welcome to Whispering
					</h2>
					<p class="text-sm leading-relaxed text-pretty text-muted-foreground">
						Press your shortcut, speak, and your words turn into text.
					</p>
				</div>
			</div>

			<div class="flex w-full flex-col gap-3">
				{#each TRUST_POINTS as point}
					{@const Icon = point.Icon}
					<Item.Root variant="muted">
						<Item.Media variant="icon">
							<Icon class="size-5" />
						</Item.Media>
						<Item.Content>
							<Item.Title>{point.title}</Item.Title>
							<Item.Description>{point.description}</Item.Description>
						</Item.Content>
					</Item.Root>
				{/each}
			</div>

			<Button
				size="lg"
				class="w-full"
				onclick={() => (showWelcome = false)}
			>
				Get started
			</Button>
		</div>
	{:else}
	<div
		class="flex w-full max-w-lg flex-col items-center gap-8"
		in:fade={fadeIn}
	>
		<!-- Progress header -->
		<div class="flex w-full items-center">
			{#each steps as step, i}
				{@const status = statusOf(i)}
				<div class="flex flex-col items-center gap-2">
					<div
						class="flex size-9 items-center justify-center rounded-full border text-sm font-medium transition-all duration-300 {status ===
						'done'
							? 'border-primary bg-primary text-primary-foreground'
							: status === 'current'
								? 'border-primary text-primary ring-4 ring-primary/15'
								: 'border-border text-muted-foreground'}"
					>
						{#if status === 'done'}
							<span in:scale={popIn}><Check class="size-4" /></span>
						{:else}
							{i + 1}
						{/if}
					</div>
					<span
						class="text-xs font-medium transition-colors {status === 'current'
							? 'text-primary'
							: 'text-muted-foreground'}">{step.label}</span>
				</div>
				{#if i < steps.length - 1}
					<div class="mx-2 mb-6 h-0.5 flex-1 overflow-hidden rounded-full bg-border">
						<div
							class="h-full rounded-full bg-primary transition-all duration-500 ease-out"
							style="width: {i < stepIndex || done ? '100%' : '0%'}"
						></div>
					</div>
				{/if}
			{/each}
		</div>

		<!-- Body -->
		<div bind:this={bodyEl} tabindex="-1" class="w-full outline-none">
			{#key transitionKey}
				<div in:fly={flyIn}>
					{#if done}
						<div class="flex flex-col items-center gap-5 py-6 text-center">
							<div
								class="flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary motion-safe:animate-[success-pop_260ms_ease-out]"
							>
								<Sparkles class="size-6" />
							</div>
							<div class="space-y-1.5">
								<h2 class="text-xl font-semibold tracking-tight">
									{dictationCapability.isActive
										? "You're ready to dictate anywhere"
										: "You're ready to record in Whispering"}
								</h2>
								<p
									class="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground"
								>
									{dictationCapability.isActive
										? 'Press your shortcut in any app, speak, and your words appear.'
										: 'Click the microphone on the home screen and speak. You can turn on dictate-anywhere later.'}
								</p>
							</div>
							{#if dictationCapability.isActive && shortcutLabel}
								<div
									class="inline-flex items-center gap-1.5 rounded-lg bg-muted/60 px-3 py-2 text-sm"
								>
									<span class="text-muted-foreground">Try it now:</span>
									<Kbd.Root>{shortcutLabel}</Kbd.Root>
								</div>
							{/if}
							<Button size="lg" onclick={onComplete}>Start dictating</Button>
						</div>
					{:else if current?.key === 'engine'}
						<div class="w-full space-y-4">
							<div class="space-y-1 text-center">
								<h2 class="text-xl font-semibold tracking-tight">
									Set up your voice engine
								</h2>
								<p class="text-sm text-muted-foreground">
									{transcriptionReadiness.primaryIssue ??
										'Choose where transcription runs. You can change it anytime.'}
								</p>
							</div>
							<!--
								Lead with the one decision that matters at first run: where
								transcription runs (on device vs cloud). The chosen location's
								recommended setup renders right below; the full provider list, a
								wall of unfamiliar names that reads as "developer tool", stays
								behind "Use a different service". Desktop only: web has no local
								engine, so it goes straight to the cloud setup.
							-->
							{#if tauri}
								<div
									role="radiogroup"
									aria-label="Where transcription runs"
									class="grid grid-cols-2 gap-3"
								>
									{#each ENGINE_LOCATIONS as location (location.value)}
										{@const Icon = location.Icon}
										{@const selected = currentLocation === location.value}
										<button
											type="button"
											role="radio"
											aria-checked={selected}
											onclick={() => chooseLocation(location.value)}
											class="flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 {selected
												? 'border-primary bg-primary/5'
												: 'hover:bg-muted/50'}"
										>
											<div class="flex flex-wrap items-center gap-2">
												<Icon
													class="size-4 shrink-0 {selected
														? 'text-primary'
														: 'text-muted-foreground'}"
												/>
												<span class="font-medium whitespace-nowrap">
													{location.label}
												</span>
												{#if location.recommended}
													<Badge variant="outline" class="text-xs">
														Recommended
													</Badge>
												{/if}
											</div>
											<span class="text-sm text-muted-foreground">
												{location.description}
											</span>
										</button>
									{/each}
								</div>
							{/if}
							<TranscriptionRuntimeConfig showAdvanced={false} />
							<Collapsible.Root>
								<Collapsible.Trigger
									class="flex w-full items-center justify-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180"
								>
									Use a different service
									<ChevronDown class="size-4 transition-transform" />
								</Collapsible.Trigger>
								<Collapsible.Content class="pt-4">
									<TranscriptionServiceSelect
										id="first-run-transcription-picker"
										label="Service"
										bind:selected={() => settings.get('transcription.service'),
											(selected) =>
												settings.set('transcription.service', selected)}
									/>
								</Collapsible.Content>
							</Collapsible.Root>
						</div>
					{:else if current?.key === 'try'}
						<div class="flex w-full flex-col items-center gap-5 text-center">
							<img src={studioMicrophone} alt="" class="size-14" />
							<div class="space-y-1.5">
								<h2 class="text-xl font-semibold tracking-tight text-balance">
									Try your first dictation
								</h2>
								<p
									class="mx-auto max-w-sm text-sm leading-relaxed text-pretty text-muted-foreground"
								>
									Click record and say anything. Whispering turns it into text.
								</p>
							</div>
							<!--
								The real recorder button, not a mock: the same card and the same
								honest states (start spinner, recording treatment) as the home
								screen, so this rehearses the exact control they'll use.
							-->
							<RecordingActionCard controller={rec} />
							{#if practiceTranscript}
								<div
									class="w-full rounded-xl border border-primary/30 bg-primary/5 p-4 text-left"
									in:fly={flyIn}
								>
									<div
										class="mb-1.5 flex items-center gap-2 text-sm font-medium text-primary"
									>
										<Check class="size-4" /> It works
									</div>
									<p class="text-sm leading-relaxed">"{practiceTranscript}"</p>
								</div>
							{/if}
						</div>
					{:else}
						<Card.Root class="border-border/70 shadow-sm dark:shadow-none dark:ring-1 dark:ring-white/5">
							<Card.Content
								class="flex flex-col items-center gap-5 px-6 py-8 text-center"
							>
								{@render panelHead(
									ShieldCheck,
									'Want to dictate in every app?',
									'To type into any other app (your editor, browser, chat) with a global shortcut, macOS needs Accessibility access. It is optional, and you can turn it on anytime.',
								)}

								{#if dictationCapability.isActive}
									<span
										class="inline-flex items-center gap-2 text-sm font-medium text-primary"
										in:scale={popIn}
									>
										<Check class="size-4" /> Accessibility is on
									</span>
								{:else}
									<Button size="lg" onclick={() => accessibilityGuide.open()}>
										<ShieldCheck class="size-4" />
										{dictationCapability.isStale
											? 'Fix Accessibility access'
											: 'Turn on Accessibility'}
									</Button>
									<p class="-mt-1 text-xs text-muted-foreground">
										Opens a short guide. We detect it automatically once it's on.
									</p>
								{/if}
							</Card.Content>
						</Card.Root>
					{/if}
				</div>
			{/key}
		</div>

		<!-- Controls -->
		{#if !done}
			<div class="flex w-full items-center justify-between">
				<Button
					variant="ghost"
					disabled={stepIndex === 0 && !startedWithWelcome}
					onclick={back}
				>
					Back
				</Button>
				{#if current?.key === 'try' && !practiceTranscript}
					<Button variant="ghost" onclick={next}>Skip</Button>
				{:else if current?.key === 'access' && !dictationCapability.isActive}
					<Button variant="ghost" onclick={next}>Skip for now</Button>
				{:else}
					<Button disabled={!requiredSatisfied} onclick={next}>
						{isLastStep ? 'Finish' : 'Continue'}
					</Button>
				{/if}
			</div>
		{/if}
	</div>
	{/if}
</div>

<style>
	@keyframes success-pop {
		0% {
			transform: scale(0.7);
			opacity: 0;
		}
		60% {
			transform: scale(1.08);
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}
</style>
