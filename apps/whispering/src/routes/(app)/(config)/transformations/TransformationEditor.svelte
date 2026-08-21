<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Card } from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Modal from '@epicenter/ui/modal';
	import { Switch } from '@epicenter/ui/switch';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { untrack } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { executeTransformation } from '$lib/operations/run-transformations';
	import { getTransformationStepError } from '$lib/operations/transformation-validation';
	import { report } from '$lib/report';
	import { getWhisperingApp } from '$lib/whispering/context';
	import type { TransformationWithSteps } from '$lib/whispering/transformations.svelte';
	import type { TransformationStep } from '$lib/workspace';

	type DraftStep = Pick<
		TransformationStep,
		'id' | 'kind' | 'find' | 'replace' | 'useRegex'
	>;

	type DraftTransformation = {
		name: string;
		description: string;
		enabled: boolean;
		steps: DraftStep[];
	};

	let {
		open = $bindable(),
		transformation,
	}: {
		open: boolean;
		transformation: TransformationWithSteps | null;
	} = $props();

	const app = getWhisperingApp();
	// The parent keys this component for every open, so the editor intentionally
	// snapshots one row rather than following sync while someone is typing.
	const initialTransformation = untrack(() => transformation);
	const originalStepIds = new Set(
		initialTransformation?.steps.map(({ id }) => id) ?? [],
	);
	let draftSequence = 0;
	const newDraftId = () => `draft-${draftSequence++}`;
	let working = $state<DraftTransformation>({
		name: initialTransformation?.name ?? '',
		description: initialTransformation?.description ?? '',
		enabled: initialTransformation?.enabled ?? false,
		steps:
			initialTransformation?.steps.map(({ id, kind, find, replace, useRegex }) => ({
				id,
				kind,
				find,
				replace,
				useRegex,
			})) ?? [],
	});
	let testInput = $state('');
	let testOutput = $state('');
	let testFailure = $state<string | null>(null);

	const stepErrors = $derived(
		working.steps.map(getTransformationStepError),
	);
	const enableError = $derived(
		working.enabled && working.steps.length === 0
			? 'Add at least one valid step before enabling this Transformation.'
			: working.enabled && stepErrors.some(Boolean)
				? 'Fix invalid steps before enabling this Transformation.'
				: null,
	);
	const canSave = $derived(
		working.name.trim().length > 0 &&
		stepErrors.every((error) => error === null) &&
		enableError === null,
	);

	function updateStep(index: number, patch: Partial<DraftStep>): void {
		working.steps = working.steps.map((step, candidate) =>
			candidate === index ? { ...step, ...patch } : step,
		);
	}

	function addFindReplace(): void {
		working.steps = [
			...working.steps,
			{
				id: newDraftId(),
				kind: 'find_replace',
				find: '',
				replace: '',
				useRegex: false,
			},
		];
	}

	function addSpokenUrls(): void {
		working.steps = [
			...working.steps,
			{
				id: newDraftId(),
				kind: 'spoken_urls',
				find: '',
				replace: '',
				useRegex: false,
			},
		];
	}

	function moveStep(index: number, direction: 'up' | 'down'): void {
		const target = direction === 'up' ? index - 1 : index + 1;
		if (target < 0 || target >= working.steps.length) return;
		const reordered = [...working.steps];
		const current = reordered[index];
		const neighbor = reordered[target];
		if (!current || !neighbor) return;
		reordered[index] = neighbor;
		reordered[target] = current;
		working.steps = reordered;
	}

	function duplicateStep(index: number): void {
		const source = working.steps[index];
		if (!source) return;
		working.steps = [
			...working.steps.slice(0, index + 1),
			{ ...source, id: newDraftId() },
			...working.steps.slice(index + 1),
		];
	}

	function removeStep(index: number): void {
		working.steps = working.steps.filter((_, candidate) => candidate !== index);
	}

	function testDraft(): void {
		const result = executeTransformation(testInput, {
			id: transformation?.id ?? 'draft',
			name: working.name.trim() || 'Unsaved Transformation',
			description: working.description,
			enabled: true,
			position: transformation?.position ?? 0,
			steps: working.steps.map((step, position) => ({
				...step,
				transformationId: transformation?.id ?? 'draft',
				position,
			})),
		});
		testOutput = result.text;
		testFailure = result.failure?.message ?? null;
	}

	function persistStep(
		transformationId: string,
		step: DraftStep,
	): TransformationStep {
		if (originalStepIds.has(step.id)) {
			app.transformations.updateStep(step.id, {
				kind: step.kind,
				find: step.find,
				replace: step.replace,
				useRegex: step.useRegex,
			});
			const updated = app.transformations
				.get(transformationId)
				?.steps.find(({ id }) => id === step.id);
			if (!updated) throw new Error(`Step '${step.id}' vanished while saving.`);
			return updated;
		}
		return app.transformations.addStep(
			transformationId,
			step.kind === 'spoken_urls'
				? { kind: 'spoken_urls' }
				: {
						kind: 'find_replace',
						find: step.find,
						replace: step.replace,
						useRegex: step.useRegex,
					},
		);
	}

	function save(): void {
		if (!canSave) return;
		try {
			const name = working.name.trim();
			const description = working.description.trim();
			const target = transformation
				? app.transformations.get(transformation.id)
				: app.transformations.create({ name, description });
			if (!target) throw new Error('The Transformation no longer exists.');

			app.transformations.setEnabled(target.id, false);
			app.transformations.update(target.id, { name, description });
			for (const originalId of originalStepIds) {
				if (!working.steps.some(({ id }) => id === originalId)) {
					app.transformations.deleteStep(originalId);
				}
			}
			const persisted = working.steps.map((step) =>
				persistStep(target.id, step),
			);
			persisted.forEach((step, desiredIndex) => {
				let currentIndex = app.transformations
					.get(target.id)
					?.steps.findIndex(({ id }) => id === step.id);
				while (currentIndex !== undefined && currentIndex > desiredIndex) {
					app.transformations.moveStep(step.id, 'up');
					currentIndex -= 1;
				}
			});
			app.transformations.setEnabled(target.id, working.enabled);
			open = false;
			report.success({
				title: transformation ? 'Transformation updated' : 'Transformation created',
			});
		} catch (cause) {
			report.info({
				title: 'Could not save Transformation',
				description: extractErrorMessage(cause),
			});
		}
	}
</script>

<Modal.Root bind:open>
	<Modal.Content class="max-w-3xl">
		<Modal.Header>
			<Modal.Title>{transformation ? 'Edit Transformation' : 'New Transformation'}</Modal.Title>
			<Modal.Description>
				Ordered local steps run after transcription and before optional Polish.
			</Modal.Description>
		</Modal.Header>

		<div class="space-y-6 overflow-y-auto p-4">
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="transformation-name">Name</Field.Label>
					<Input
						id="transformation-name"
						placeholder="Spoken technical text"
						bind:value={working.name}
					/>
					{#if !working.name.trim()}
						<Field.Error>Enter a name.</Field.Error>
					{/if}
				</Field.Field>
				<Field.Field>
					<Field.Label for="transformation-description">Description</Field.Label>
					<Input
						id="transformation-description"
						placeholder="Turn dictated URLs into links"
						bind:value={working.description}
					/>
				</Field.Field>
			</div>

			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label for="transformation-enabled">Enabled</Field.Label>
					<Field.Description>
						Enabled Transformations run automatically in list order.
					</Field.Description>
					{#if enableError}<Field.Error>{enableError}</Field.Error>{/if}
				</Field.Content>
				<Switch id="transformation-enabled" bind:checked={working.enabled} />
			</Field.Field>

			<section class="space-y-3" aria-labelledby="steps-heading">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h3 id="steps-heading" class="font-semibold">Steps</h3>
						<p class="text-sm text-muted-foreground">Run from top to bottom.</p>
					</div>
					<div class="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onclick={addFindReplace}>
							<PlusIcon class="size-4" /> Find and replace
						</Button>
						<Button variant="outline" size="sm" onclick={addSpokenUrls}>
							<PlusIcon class="size-4" /> Spoken URLs
						</Button>
					</div>
				</div>

				{#if working.steps.length === 0}
					<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
						No steps yet. Save this as a disabled draft, or add a step.
					</p>
				{:else}
					<ol class="space-y-3">
						{#each working.steps as step, index (step.id)}
							<li>
								<Card class="space-y-3 p-4">
									<div class="flex items-center justify-between gap-2">
										<div class="font-medium">
											{index + 1}. {step.kind === 'spoken_urls'
												? 'Spoken URLs'
												: 'Find and replace'}
										</div>
										<div class="flex items-center gap-1">
											<Button
												variant="ghost"
												size="icon"
												tooltip="Move step up"
												disabled={index === 0}
												onclick={() => moveStep(index, 'up')}
											><ArrowUpIcon class="size-4" /></Button
											>
											<Button
												variant="ghost"
												size="icon"
												tooltip="Move step down"
												disabled={index === working.steps.length - 1}
												onclick={() => moveStep(index, 'down')}
											><ArrowDownIcon class="size-4" /></Button
											>
											<Button
												variant="ghost"
												size="icon"
												tooltip="Duplicate step"
												onclick={() => duplicateStep(index)}
											><CopyIcon class="size-4" /></Button
											>
											<Button
												variant="ghost"
												size="icon"
												tooltip="Delete step"
												onclick={() => removeStep(index)}
											><TrashIcon class="size-4" /></Button
											>
										</div>
									</div>

									{#if step.kind === 'find_replace'}
										<div class="grid gap-3 sm:grid-cols-2">
											<Field.Field>
												<Field.Label for="find-{step.id}">Find</Field.Label>
												<Input
													id="find-{step.id}"
													value={step.find}
													oninput={(event) =>
														updateStep(index, { find: event.currentTarget.value })}
												/>
												{#if stepErrors[index]}
													<Field.Error>{stepErrors[index]}</Field.Error>
												{/if}
											</Field.Field>
											<Field.Field>
												<Field.Label for="replace-{step.id}">Replace</Field.Label>
												<Input
													id="replace-{step.id}"
													value={step.replace}
													oninput={(event) =>
														updateStep(index, {
															replace: event.currentTarget.value,
														})}
												/>
											</Field.Field>
										</div>
										<Field.Field orientation="horizontal">
											<Field.Content>
												<Field.Label for="regex-{step.id}">Use regex</Field.Label>
												<Field.Description>Match a regular expression globally.</Field.Description>
											</Field.Content>
											<Switch
												id="regex-{step.id}"
												checked={step.useRegex}
												onCheckedChange={(useRegex) =>
													updateStep(index, { useRegex })}
											/>
										</Field.Field>
									{:else}
										<p class="text-sm text-muted-foreground">
											Converts explicitly dictated HTTP or HTTPS punctuation into a URL.
										</p>
									{/if}
								</Card>
							</li>
						{/each}
					</ol>
				{/if}
			</section>

			<section class="space-y-3" aria-labelledby="test-heading">
				<div>
					<h3 id="test-heading" class="font-semibold">Test unsaved draft</h3>
					<p class="text-sm text-muted-foreground">Runs locally and saves no history.</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="test-input">Input</Field.Label>
						<Textarea id="test-input" rows={5} bind:value={testInput} />
					</Field.Field>
					<Field.Field>
						<Field.Label for="test-output">Output</Field.Label>
						<Textarea id="test-output" rows={5} value={testOutput} readonly />
						{#if testFailure}<Field.Error>{testFailure}</Field.Error>{/if}
					</Field.Field>
				</div>
				<Button variant="outline" onclick={testDraft} disabled={!testInput.trim()}>
					<PlayIcon class="size-4" /> Run test
				</Button>
			</section>
		</div>

		<Modal.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={save} disabled={!canSave}>
				{transformation ? 'Save changes' : 'Create Transformation'}
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
