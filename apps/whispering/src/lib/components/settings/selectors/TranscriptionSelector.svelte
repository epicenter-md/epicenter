<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import * as Empty from '@epicenter/ui/empty';
	import { useCombobox } from '@epicenter/ui/hooks';
	import { Loading } from '@epicenter/ui/loading';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CaptionsIcon from '@lucide/svelte/icons/captions';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import HardDriveDownloadIcon from '@lucide/svelte/icons/hard-drive-download';
	import MicIcon from '@lucide/svelte/icons/mic';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { goto } from '$app/navigation';
	import { whisperingPath } from '$lib/constants/urls';
	import { readyTranscribers } from '$lib/settings/transcription-switcher';
	import {
		getLocalRouteState,
		getSelectedTranscriptionService,
		getTranscriptionReadiness,
	} from '$lib/settings/transcription-validation';
	import { auth } from '#platform/auth';
	import { tauri } from '#platform/tauri';
	import TranscriberRow from './TranscriberRow.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let {
		class: className,
		variant,
		iconViewTransitionName,
	}: {
		class?: string;
		/**
		 * Where this selector is rendered, which determines how a missing or
		 * unusable transcription service is treated:
		 * - `pipeline`: a required capture stage. Shows the active model's name and
		 *   a captions icon, and warns whenever nothing usable is configured
		 *   (including a web user whose saved service is desktop-only).
		 * - `standalone`: a quick switcher. Shows the active service's brand icon
		 *   and warns only when the selected service is misconfigured.
		 */
		variant: 'standalone' | 'pipeline';
		/** When set, names the trigger's brand glyph for a cross-page view transition. */
		iconViewTransitionName?: string;
	} = $props();

	// The ready transcribers: downloaded on-device GGUFs unioned with configured
	// session, keyed, and endpoint providers. Each transcriber owns its own title,
	// so the trigger just reads the active one.
	const transcribers = $derived(readyTranscribers(app));
	const activeTranscriber = $derived(
		transcribers.find((transcriber) => transcriber.isActive),
	);

	const selectedService = $derived(getSelectedTranscriptionService(app));
	const readiness = $derived(getTranscriptionReadiness(app));
	const isSelectedServiceReady = $derived(readiness.isReady);
	const showConfigurationWarning = $derived(
		variant === 'pipeline'
			? !isSelectedServiceReady
			: !!selectedService && !isSelectedServiceReady,
	);

	// The pipeline trigger surfaces the active transcriber: a curated on-device
	// model name or a remote provider name. Exact remote model ids stay in the
	// expanded rows and settings.
	const pipelineLabel = $derived(
		activeTranscriber?.title ?? selectedService?.label ?? 'Choose model',
	);

	// The pipeline pill already shows the transcriber name, so its tooltip
	// describes the action. The icon-only standalone switcher keeps the exact
	// configured context.
	const triggerTooltip = $derived.by(() => {
		if (variant === 'pipeline') {
			return selectedService
				? 'Change transcription model'
				: 'Choose transcription model';
		}
		if (activeTranscriber) {
			const model = activeTranscriber.modelId
				? ` - ${activeTranscriber.modelId}`
				: '';
			const host = activeTranscriber.endpointHost
				? ` · ${activeTranscriber.endpointHost}`
				: '';
			return `${activeTranscriber.title}${model}${host}`;
		}
		return selectedService
			? selectedService.label
			: 'Select transcription service';
	});

	const combobox = useCombobox();

	// `transcribers` is empty only when nothing is set up and the user is signed
	// out (a signed-in user always has the session transcriber). On desktop the
	// privacy-forward path is to set up a local model, which Epicenter Home owns
	// (ADR-0180), so this surface points there instead of downloading one itself.
	// Web has no local route at all and offers sign-in or an API key.
	const localRouteState = $derived(getLocalRouteState());
</script>

{#snippet triggerBrandIcon(icon: string, invertInDarkMode: boolean, dimmed = false)}
	<div
		class={cn(
			'size-4 flex items-center justify-center [&>svg]:size-full',
			invertInDarkMode && 'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
			dimmed && 'opacity-60',
		)}
		style:view-transition-name={iconViewTransitionName}
	>
		{@html icon}
	</div>
{/snippet}

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn(
					'relative',
					variant === 'pipeline' && 'min-w-0 flex-1 justify-start',
					className,
				)}
				tooltip={triggerTooltip}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size={variant === 'pipeline' ? 'default' : 'icon'}
			>
				{#if variant === 'pipeline'}
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={iconViewTransitionName}
					>
						{#if selectedService}
							{@render triggerBrandIcon(
								selectedService.icon,
								selectedService.invertInDarkMode,
							)}
						{:else}
							<CaptionsIcon class="size-4 text-warning" />
						{/if}
					</span>
					<span
						class={cn(
							'truncate text-sm font-medium',
							!isSelectedServiceReady && 'text-warning',
						)}
					>
						{pipelineLabel}
					</span>
					<ChevronDownIcon
						class="ml-auto size-3.5 shrink-0 text-muted-foreground/70"
					/>
				{:else if selectedService}
					{@render triggerBrandIcon(
						selectedService.icon,
						selectedService.invertInDarkMode,
						!isSelectedServiceReady,
					)}
				{:else}
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={iconViewTransitionName}
					>
						<MicIcon class="size-4 text-muted-foreground" />
					</span>
				{/if}
				{#if showConfigurationWarning && variant === 'standalone'}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-warning before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-warning/50 before:animate-ping"
					></span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		{#if transcribers.length === 0}
			<!-- Signed out with nothing set up: privacy-forward on desktop, remote
			setup on web. Never auto-selects a provider. -->
			{#if tauri && localRouteState === 'loading'}
				<Loading class="py-8" label="Checking the active local model" />
			{:else if tauri}
				<Empty.Root class="py-8">
					<Empty.Media variant="icon">
						<HardDriveDownloadIcon class="size-5" />
					</Empty.Media>
					<Empty.Title>Transcribe on this device</Empty.Title>
					<Empty.Description>
						Private, offline, and free. Epicenter Home is where you download a
						local model and make it active; it then runs every local
						transcription on this device.
					</Empty.Description>
					<Empty.Content class="flex flex-col gap-2">
						<Button
							variant="outline"
							onclick={() => {
								goto(whisperingPath('/settings/processing'));
								combobox.closeAndFocusTrigger();
							}}
						>
							Set up a cloud provider instead
						</Button>
					</Empty.Content>
				</Empty.Root>
			{:else}
				<Empty.Root class="py-8">
					<Empty.Media variant="icon">
						<MicIcon class="size-5" />
					</Empty.Media>
					<Empty.Title>Set up transcription</Empty.Title>
					<Empty.Description>
						Sign in to Epicenter or add an API key to transcribe. Nothing
						uploads your audio until you choose a provider.
					</Empty.Description>
					<Empty.Content class="flex flex-col gap-2">
						<Button onclick={() => auth.startSignIn()}>Sign in to Epicenter</Button>
						<Button
							variant="outline"
							onclick={() => {
								goto(whisperingPath('/settings/processing'));
								combobox.closeAndFocusTrigger();
							}}
						>
							Add an API key
						</Button>
					</Empty.Content>
				</Empty.Root>
			{/if}
		{:else}
			<Command.Root loop>
				<Command.Input placeholder="Search models..." class="h-9 text-sm" />
				<Command.List class="max-h-[40vh]">
					<Command.Empty>No model found.</Command.Empty>

					{#each transcribers as transcriber (transcriber.key)}
						<TranscriberRow
							{transcriber}
							onSelect={combobox.closeAndFocusTrigger}
						/>
					{/each}

					<Command.Separator />
					<Command.Item
						value="add a model settings configure provider"
						onSelect={() => {
							goto(whisperingPath('/settings/processing'));
							combobox.closeAndFocusTrigger();
						}}
						class="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
					>
						<PlusIcon class="size-3.5" />
						Add a model...
					</Command.Item>
				</Command.List>
			</Command.Root>
		{/if}
	</Popover.Content>
</Popover.Root>
