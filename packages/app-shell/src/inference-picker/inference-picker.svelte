<script lang="ts">
	/**
	 * The shared, model-first inference picker (ADR-0059). One flat searchable list
	 * of models grouped by connection: the hosted Epicenter catalog plus each
	 * device-local custom connection's discovered models, with "Connect a
	 * provider..." as the footer escape hatch. The model is the only leaf; the
	 * connection (billing / location) is a group facet, never a level.
	 *
	 * The device's connections, discovery, and resolution all live in the injected
	 * {@link InferenceConnections} registry, so this component is just UI: it reads
	 * the registry and calls its methods. Mounted like `<AccountPopover />`: once per
	 * chat surface, bound to that app's registry.
	 */
	import {
		CONNECTION_PRESETS,
		type ListModelsError,
		type PresetId,
	} from '@epicenter/client';
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Check from '@lucide/svelte/icons/check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Cloud from '@lucide/svelte/icons/cloud';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { SvelteSet } from 'svelte/reactivity';
	import type { InferenceConnections } from './connections.svelte.js';

	type Props = {
		/** The conversation's current model id (synced, ADR-0055). */
		model: string;
		/** Commit a model pick. Writes the synced conversation model column. */
		onSelectModel: (model: string) => void;
		/** The device's inference connection registry (hosted catalog + custom set). */
		connections: InferenceConnections;
		/** Disable while a turn generates, so a transcript never spans backends. */
		disabled?: boolean;
	};

	let { model, onSelectModel, connections, disabled = false }: Props = $props();

	let open = $state(false);
	let view = $state<'list' | 'connect'>('list');

	// "Connect a provider" form state. `formPreset` null means the preset chooser
	// is showing; a value means its sub-form is.
	let formPreset = $state<PresetId | 'custom' | null>(null);
	let formBaseUrl = $state('');
	let formApiKey = $state('');
	let formModel = $state('');
	let showKey = $state(false);

	// Discovery state for the connect form.
	let discovering = $state(false);
	let discovered = $state<string[] | null>(null);
	// A tailored, per-variant message when discovery fails (401 vs unreachable vs
	// malformed), or null when discovery has not failed.
	let discoveryError = $state<string | null>(null);

	// Connections currently re-discovering their models, for per-group refresh
	// spinners. Usually one entry, but keep the set keyed per URL so overlapping
	// refreshes cannot clear each other's loading state.
	const refreshingBaseUrls = new SvelteSet<string>();

	// Clear all of the connect form's working state. Called on close so a user who
	// connected one provider lands back on the preset chooser (not a stale sub-form
	// with a leftover typed API key) the next time they open the picker.
	function resetConnectForm() {
		formPreset = null;
		formBaseUrl = '';
		formApiKey = '';
		formModel = '';
		showKey = false;
		discovering = false;
		discovered = null;
		discoveryError = null;
	}

	// Turn a discovery failure into an actionable hint per variant, so the user
	// knows whether to fix the URL, the key, or just type a model.
	function discoveryMessage(error: ListModelsError): string {
		switch (error.name) {
			case 'Unreachable':
				return "Couldn't reach this endpoint. Check the URL and that the server is running, or type a model manually.";
			case 'RequestFailed':
				if (error.status === 401 || error.status === 403)
					return 'The endpoint rejected this API key. Check the key, then type a model manually.';
				return `The endpoint returned ${error.status}. Type a model manually.`;
			case 'Malformed':
				return "This endpoint didn't return an OpenAI model list. Type a model manually.";
		}
	}

	function isLocal(baseUrl: string): boolean {
		return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(baseUrl);
	}

	function localityLabel(baseUrl: string): 'local' | 'cloud' {
		return isLocal(baseUrl) ? 'local' : 'cloud';
	}

	// Derive the group label from the stored base URL: match a preset by its full
	// normalized base URL (so a self-hosted proxy that merely shares a host won't
	// false-match, and Ollama's :11434 stays distinct from LM Studio's :1234), else
	// fall back to the URL host. Derived, not stored, so it cannot drift when the
	// user edits the URL (ADR-0060).
	function connectionLabel(baseUrl: string): string {
		const normalized = baseUrl.replace(/\/+$/, '');
		const preset = CONNECTION_PRESETS.find(
			(p) => p.baseUrl.replace(/\/+$/, '') === normalized,
		);
		if (preset) return preset.label;
		try {
			return new URL(baseUrl).host;
		} catch {
			return baseUrl;
		}
	}

	const requiresKey = $derived(
		formPreset === 'custom' ||
			(formPreset !== null &&
				(CONNECTION_PRESETS.find((p) => p.id === formPreset)?.requiresKey ??
					false)),
	);

	// The label on the closed trigger: a hosted model shows its product role
	// (Fast, Best); a custom model shows its raw id (Ollama ids have no nice name).
	const triggerLabel = $derived(
		!model
			? 'Select model'
			: (connections.hostedModels.find((m) => m.id === model)?.label ?? model),
	);

	function selectModel(id: string) {
		onSelectModel(id);
		open = false;
	}

	// Re-discover a connected endpoint's models in place. Best effort: the group's
	// list updates reactively when the fresh ids land, and stands on error.
	async function refreshConnection(baseUrl: string) {
		if (refreshingBaseUrls.has(baseUrl)) return;
		refreshingBaseUrls.add(baseUrl);
		try {
			await connections.refresh(baseUrl);
		} finally {
			refreshingBaseUrls.delete(baseUrl);
		}
	}

	function choosePreset(id: PresetId | 'custom') {
		formPreset = id;
		formApiKey = '';
		formModel = '';
		discovered = null;
		discoveryError = null;
		formBaseUrl =
			id === 'custom'
				? ''
				: (CONNECTION_PRESETS.find((p) => p.id === id)?.baseUrl ?? '');
	}

	// Save the connection being configured (caching its discovered models), select
	// the chosen model, and close: one commit for the whole "connect and use" path.
	function commitConnection(chosenModel: string) {
		const baseUrl = formBaseUrl.trim();
		const trimmedModel = chosenModel.trim();
		if (!baseUrl || !trimmedModel) return;
		connections.add(
			{
				baseUrl,
				apiKey: formApiKey.trim() || undefined,
			},
			discovered ?? undefined,
		);
		onSelectModel(trimmedModel);
		open = false;
	}

	// Reopening the picker always lands on the model list, never a half-filled form.
	$effect(() => {
		if (!open) {
			view = 'list';
			resetConnectForm();
		}
	});

	// Auto-discover on a debounced change of the connect form's endpoint or key.
	// Best effort: a failure degrades to the free-text model floor, never a toast.
	$effect(() => {
		if (view !== 'connect') return;
		const url = formBaseUrl.trim();
		const key = formApiKey.trim();
		if (!url) {
			discovered = null;
			discoveryError = null;
			discovering = false;
			return;
		}
		let cancelled = false;
		discovering = true;
		discoveryError = null;
		const handle = setTimeout(async () => {
			const { data, error } = await connections.discover(url, key || undefined);
			if (cancelled) return;
			discovering = false;
			if (error) {
				discovered = null;
				discoveryError = discoveryMessage(error);
				return;
			}
			discovered = data;
		}, 500);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	});
</script>

{#snippet localityIcon(baseUrl: string)}
	{#if isLocal(baseUrl)}
		<HardDrive class="size-4 shrink-0 opacity-70" />
	{:else}
		<Cloud class="size-4 shrink-0 opacity-70" />
	{/if}
{/snippet}

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{disabled}
				variant="outline"
				size="sm"
				role="combobox"
				aria-expanded={open}
				class="max-w-56 justify-between gap-2 font-normal"
			>
				<span class="truncate">{triggerLabel}</span>
				<ChevronsUpDown class="size-4 shrink-0 opacity-50" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if view === 'list'}
			<Command.Root>
				<Command.Input placeholder="Search models..." />
				<Command.List class="max-h-80">
					<Command.Empty>No models found.</Command.Empty>

					{#if connections.hostedModels.length > 0}
						<Command.Group heading="Epicenter · metered">
							{#each connections.hostedModels as hostedModel (hostedModel.id)}
								<Command.Item
									value={`${hostedModel.label} ${hostedModel.id}`}
									keywords={[hostedModel.id, hostedModel.label]}
									onSelect={() => selectModel(hostedModel.id)}
								>
									<Check
										class="size-4 shrink-0 {model === hostedModel.id
											? 'opacity-100'
											: 'opacity-0'}"
									/>
									<span class="flex-1 truncate">{hostedModel.label}</span>
									<span class="text-xs text-muted-foreground">
										{hostedModel.credits} cr
									</span>
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}

					{#each connections.custom as connection (connection.baseUrl)}
						{@const ids = connection.models ?? []}
						{@const label = connectionLabel(connection.baseUrl)}
						{@const locality = localityLabel(connection.baseUrl)}
						<Command.Group heading="{label} · {locality}">
							{#each ids as id (id)}
								<Command.Item
									value="{id} {label}"
									keywords={[id]}
									onSelect={() => selectModel(id)}
								>
									<Check
										class="size-4 shrink-0 {model === id
											? 'opacity-100'
											: 'opacity-0'}"
									/>
									{@render localityIcon(connection.baseUrl)}
									<span
										class="line-clamp-2 flex-1 break-all {model === id
											? 'font-medium'
											: ''}"
										title={id}>{id}</span>
								</Command.Item>
							{:else}
								<Command.Item disabled value="{connection.baseUrl} empty">
									<span class="text-xs text-muted-foreground">
										No models discovered
									</span>
								</Command.Item>
							{/each}
							<Command.Item
								value="refresh {connection.baseUrl}"
								disabled={refreshingBaseUrls.has(connection.baseUrl)}
								onSelect={() => refreshConnection(connection.baseUrl)}
							>
								{#if refreshingBaseUrls.has(connection.baseUrl)}
									<LoaderCircle class="size-4 animate-spin" />
								{:else}
									<RefreshCw class="size-4" />
								{/if}
								<span class="text-xs">Refresh {label}</span>
							</Command.Item>
							<Command.Item
								value="remove {connection.baseUrl}"
								onSelect={() => connections.remove(connection.baseUrl)}
							>
								<Trash2 class="size-4" />
								<span class="text-xs">Remove {label}</span>
							</Command.Item>
						</Command.Group>
					{/each}

					<Command.Separator />
					<Command.Item
						value="connect a provider"
						onSelect={() => (view = 'connect')}
					>
						<Plus class="size-4" />
						<span>Connect a provider...</span>
					</Command.Item>
				</Command.List>
			</Command.Root>
		{:else}
			<div class="space-y-3 p-3">
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => (view = 'list')}
						aria-label="Back to models"
					>
						<ArrowLeft class="size-4" />
					</Button>
					<p class="text-sm font-medium">Connect a provider</p>
				</div>

				{#if formPreset === null}
					<Command.Root class="rounded-md border">
						<Command.List>
							{#each CONNECTION_PRESETS as preset (preset.id)}
								<Command.Item
									value={preset.label}
									onSelect={() => choosePreset(preset.id)}
								>
									{@render localityIcon(preset.baseUrl)}
									<span class="flex-1">{preset.label}</span>
									<span class="text-xs text-muted-foreground">
										{localityLabel(preset.baseUrl)}
									</span>
								</Command.Item>
							{/each}
							<Command.Separator />
							<Command.Item
								value="custom url"
								onSelect={() => choosePreset('custom')}
							>
								<Plus class="size-4 shrink-0 opacity-70" />
								<span class="flex-1">Custom URL</span>
							</Command.Item>
						</Command.List>
					</Command.Root>
				{:else}
					<div class="space-y-1">
						<Label for="conn-url" class="text-xs">Base URL</Label>
						<Input
							id="conn-url"
							bind:value={formBaseUrl}
							placeholder="http://localhost:11434/v1"
						/>
					</div>

					{#if requiresKey}
						<div class="space-y-1">
							<Label for="conn-key" class="text-xs">
								API key{formPreset === 'custom' ? ' (optional)' : ''}
							</Label>
							<div class="flex gap-1">
								<Input
									id="conn-key"
									type={showKey ? 'text' : 'password'}
									bind:value={formApiKey}
									placeholder="sk-..."
								/>
								<Button
									variant="ghost"
									size="icon-sm"
									onclick={() => (showKey = !showKey)}
									aria-label={showKey ? 'Hide key' : 'Show key'}
								>
									{#if showKey}
										<EyeOff class="size-4" />
									{:else}
										<Eye class="size-4" />
									{/if}
								</Button>
							</div>
						</div>
					{/if}

					<div class="space-y-1">
						<Label class="text-xs">Model</Label>
						{#if discovering}
							<p class="flex items-center gap-2 text-xs text-muted-foreground">
								<LoaderCircle class="size-3.5 animate-spin" /> Loading models...
							</p>
						{:else if discovered && discovered.length > 0}
							<p class="text-xs text-muted-foreground">
								Pick a model to start using it.
							</p>
							<Command.Root class="rounded-md border">
								<Command.Input placeholder="Search models..." />
								<Command.List class="max-h-48">
									<Command.Empty>No models found.</Command.Empty>
									{#each discovered as id (id)}
										<Command.Item
											value={id}
											keywords={[id]}
											onSelect={() => commitConnection(id)}
										>
											<span class="line-clamp-2 break-all" title={id}>{id}</span>
										</Command.Item>
									{/each}
								</Command.List>
							</Command.Root>
						{:else}
							{#if discoveryError}
								<p class="text-xs text-muted-foreground">
									{discoveryError}
								</p>
							{:else if formBaseUrl.trim()}
								<p class="text-xs text-muted-foreground">
									No models found at this endpoint, type one manually.
								</p>
							{:else}
								<p class="text-xs text-muted-foreground">
									Enter an endpoint to load models.
								</p>
							{/if}
							<div class="flex gap-1">
								<Input bind:value={formModel} placeholder="qwen2.5:3b" />
								<Button
									size="sm"
									disabled={!formBaseUrl.trim() || !formModel.trim()}
									onclick={() => commitConnection(formModel)}
								>
									Add
								</Button>
							</div>
						{/if}
					</div>

					<p class="text-xs text-muted-foreground">
						Requests go straight to this URL. Your Epicenter sign-in is never
						sent there.
					</p>
				{/if}
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
