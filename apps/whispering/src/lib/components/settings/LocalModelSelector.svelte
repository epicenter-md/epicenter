<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';
	import HardDriveDownload from '@lucide/svelte/icons/hard-drive-download';
	import Trash from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { localModels } from '$lib/state/local-models.svelte';
	import type { ModelInfo } from '$lib/tauri/commands.types';

	/**
	 * The one local-model picker: a flat list of Rust-catalog GGUF models, each
	 * with its download / cancel / activate / delete affordance. Rust owns the
	 * catalog, capabilities, and shared-HF-cache download; this view reads the
	 * `localModels` store and binds the selection (a model id) as `value`.
	 */
	let {
		value = $bindable(),
	}: {
		/** Bindable catalog id of the active model. */
		value: string;
	} = $props();

	// Re-scan on mount and window focus: the shared HF cache can change outside
	// the app (another HF tool, a manual delete), so the download status stays
	// honest.
	$effect(() => {
		localModels.refresh();
	});

	/** The recommended model; the empty-state hero builds its action around it. */
	const recommended = $derived(
		localModels.models.find((model) => model.recommended) ??
			localModels.models[0],
	);
	const recommendedState = $derived(
		recommended ? localModels.stateOf(recommended) : null,
	);

	/** The active model, when the selection resolves to a downloaded catalog one. */
	const activeModel = $derived(localModels.find(value) ?? null);
	const anyDownloaded = $derived(
		localModels.models.some((model) => model.downloaded),
	);

	// "Missing" means the selection points at a model that is not downloaded (an
	// unknown id, or one deleted from the cache).
	const isSelectionMissing = $derived(
		!!value && localModels.loaded && !activeModel?.downloaded,
	);

	let allModelsOpen = $state(false);

	function formatSize(bytes: number | null): string {
		if (!bytes) return '';
		const mb = bytes / 1_000_000;
		return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
	}

	function activate(model: ModelInfo) {
		value = model.id;
		toast.success('Model activated');
	}

	async function download(model: ModelInfo) {
		const result = await localModels.download(model);
		if (!result) return;
		if (result.error) {
			toast.error('Failed to download model', {
				description: result.error.message,
			});
			return;
		}
		value = result.data.modelId;
		toast.success(
			result.data.outcome === 'already-installed'
				? 'Model already downloaded and activated'
				: 'Model downloaded and activated',
		);
	}

	async function remove(model: ModelInfo) {
		const { error } = await localModels.remove(model);
		if (error) {
			toast.error('Failed to delete model', { description: error.message });
			return;
		}
		if (value === model.id) value = '';
		toast.success('Model deleted');
	}
</script>

<svelte:window onfocus={localModels.refresh} />

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">Local Model</Card.Title>
		<Card.Description>
			Download a model to transcribe on this device: private, offline, and
			free. Models are stored in your shared Hugging Face cache.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if value && !isSelectionMissing && activeModel}
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Title>{activeModel.name}</Item.Title>
					<Item.Description>{formatSize(activeModel.sizeBytes)}</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Badge class="text-xs">Active</Badge>
					<Button
						variant="outline"
						size="sm"
						onclick={() => (allModelsOpen = true)}
					>
						Change
					</Button>
				</Item.Actions>
			</Item.Root>
		{:else if !anyDownloaded && recommended && recommendedState}
			<Empty.Root class="py-8">
				<Empty.Media variant="icon">
					<HardDriveDownload class="size-5" />
				</Empty.Media>
				<Empty.Title>No local model installed</Empty.Title>
				<Empty.Description>
					Runs on this device: private, offline, and free. Download the
					recommended model to start transcribing.
				</Empty.Description>
				<Empty.Content>
					{#if recommendedState.type === 'downloading'}
						<div class="flex w-full max-w-xs flex-col items-center gap-2">
							<Progress value={recommendedState.progress} class="h-2" />
							<span class="text-sm text-muted-foreground">
								Downloading {recommended.name}: {recommendedState.progress}%
							</span>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => localModels.cancel(recommended)}
								disabled={recommendedState.cancelling}
							>
								<X class="size-4" />
								{recommendedState.cancelling ? 'Cancelling…' : 'Cancel'}
							</Button>
						</div>
					{:else}
						<Button onclick={() => download(recommended)}>
							<Download class="size-4" />
							Download {recommended.name} ({formatSize(recommended.sizeBytes)})
						</Button>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{/if}

		{#if isSelectionMissing}
			<div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
				<p class="text-sm font-medium text-amber-600 dark:text-amber-400">
					Selected model is not downloaded
				</p>
				<p class="mt-1 text-sm text-muted-foreground">
					Download it again under All models, or pick another model.
				</p>
			</div>
		{/if}

		<Collapsible.Root bind:open={allModelsOpen}>
			<Collapsible.Trigger
				class="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180"
			>
				All models ({localModels.models.length})
				<ChevronDown
					class="size-4 shrink-0 text-muted-foreground transition-transform"
				/>
			</Collapsible.Trigger>
			<Collapsible.Content class="space-y-3 pt-3">
				{#each localModels.models as model (model.id)}
					{@const state = localModels.stateOf(model)}
					{@const isActive = value === model.id && model.downloaded}
					<div
						class="flex items-center gap-3 rounded-lg border p-3 {isActive
							? 'border-primary bg-primary/5'
							: ''}"
					>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="font-medium">{model.name}</span>
								{#if model.recommended}
									<Badge variant="outline" class="text-xs">Recommended</Badge>
								{/if}
								{#if isActive}
									<Badge variant="default" class="text-xs">Active</Badge>
								{:else if model.downloaded}
									<Badge variant="secondary" class="text-xs">Downloaded</Badge>
								{/if}
							</div>
							<div class="text-sm text-muted-foreground">
								{model.description} · {formatSize(model.sizeBytes)}
							</div>
						</div>

						<div class="flex items-center gap-2">
							{#if state.type === 'downloading'}
								<span class="text-sm text-muted-foreground tabular-nums">
									{state.progress}%
								</span>
								<Button
									size="sm"
									variant="ghost"
									onclick={() => localModels.cancel(model)}
									disabled={state.cancelling}
								>
									<X class="size-4" />
									{state.cancelling ? 'Cancelling…' : 'Cancel'}
								</Button>
							{:else if state.type === 'ready'}
								{#if isActive}
									<Button size="sm" variant="default" disabled>
										<CheckIcon class="mr-1 size-4" />
										Activated
									</Button>
								{:else}
									<Button
										size="sm"
										variant="outline"
										onclick={() => activate(model)}
									>
										Activate
									</Button>
								{/if}
								<Button size="sm" variant="ghost" onclick={() => remove(model)}>
									<Trash class="size-4" />
								</Button>
							{:else}
								<Button size="sm" onclick={() => download(model)}>
									<Download class="mr-1 size-4" />
									Download
								</Button>
							{/if}
						</div>
					</div>

					{#if state.type === 'downloading' && state.progress > 0}
						<Progress value={state.progress} class="h-2" />
					{/if}
				{/each}
			</Collapsible.Content>
		</Collapsible.Root>
	</Card.Content>
</Card.Root>
