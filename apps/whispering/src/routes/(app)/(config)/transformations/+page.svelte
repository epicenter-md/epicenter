<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Card } from '@epicenter/ui/card';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Switch } from '@epicenter/ui/switch';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReplaceAllIcon from '@lucide/svelte/icons/replace-all';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { report } from '$lib/report';
	import { getWhisperingApp } from '$lib/whispering/context';
	import type { TransformationWithSteps } from '$lib/whispering/transformations.svelte';
	import TransformationEditor from './TransformationEditor.svelte';

	const app = getWhisperingApp();
	let editorOpen = $state(false);
	let editorGeneration = $state(0);
	let editing = $state.raw<TransformationWithSteps | null>(null);

	function openNew(): void {
		editing = null;
		editorGeneration += 1;
		editorOpen = true;
	}

	function openEdit(transformation: TransformationWithSteps): void {
		editing = transformation;
		editorGeneration += 1;
		editorOpen = true;
	}

	function setEnabled(
		transformation: TransformationWithSteps,
		enabled: boolean,
	): void {
		try {
			app.transformations.setEnabled(transformation.id, enabled);
		} catch (cause) {
			report.info({
				title: 'Could not enable Transformation',
				description: extractErrorMessage(cause),
			});
		}
	}

	function remove(transformation: TransformationWithSteps): void {
		confirmationDialog.open({
			title: `Delete ${transformation.name}?`,
			description:
				'This removes the Transformation and all of its steps everywhere.',
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: () => {
				app.transformations.delete(transformation.id);
				report.success({ title: 'Transformation deleted' });
			},
		});
	}
</script>

<svelte:head> <title>Transformations</title> </svelte:head>

<main class="flex w-full flex-1 flex-col gap-2 px-4 py-4 sm:px-8 mx-auto">
	<SectionHeader.Root>
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Transformations
		</SectionHeader.Title>
		<SectionHeader.Description>
			Ordered local text changes that run after transcription and before optional
			Polish.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Card class="flex flex-col gap-4 p-6">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<h2 class="text-lg font-semibold">Execution order</h2>
				<p class="text-sm text-muted-foreground">
					Enabled rows run from top to bottom. Disabled rows keep their place.
				</p>
			</div>
			<Button variant="outline" onclick={openNew}>
				<PlusIcon class="size-4" /> New Transformation
			</Button>
		</div>

		{#if app.transformations.sorted.length === 0}
			<Empty.Root class="py-8">
				<Empty.Header>
					<Empty.Media variant="icon"><ReplaceAllIcon /></Empty.Media>
					<Empty.Title>No Transformations yet</Empty.Title>
					<Empty.Description>
						Create one when you want Whispering to rewrite text locally before
						optional Polish.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={openNew}><PlusIcon class="size-4" /> New Transformation</Button>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<ol class="flex flex-col divide-y">
				{#each app.transformations.sorted as transformation, index (transformation.id)}
					<li
						class:opacity-60={!transformation.enabled}
						class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"
					>
						<div class="flex min-w-0 flex-1 items-start gap-3">
							<span
								class="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium"
								aria-label="Execution position {index + 1}"
							>
								{index + 1}
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{transformation.name}</span>
									<Badge variant={transformation.enabled ? 'default' : 'secondary'}>
										{transformation.enabled ? 'Enabled' : 'Skipped'}
									</Badge>
									<span class="text-xs text-muted-foreground">
										{transformation.steps.length} {transformation.steps.length === 1
											? 'step'
											: 'steps'}
									</span>
								</div>
								{#if transformation.description}
									<p class="mt-1 text-sm text-muted-foreground">
										{transformation.description}
									</p>
								{/if}
							</div>
						</div>

						<div class="flex shrink-0 items-center gap-1 self-end sm:self-auto">
							<Switch
								checked={transformation.enabled}
								aria-label="Enable {transformation.name}"
								onCheckedChange={(enabled) => setEnabled(transformation, enabled)}
							/>
							<Button
								variant="ghost"
								size="icon"
								tooltip="Move Transformation up"
								disabled={index === 0}
								onclick={() => app.transformations.move(transformation.id, 'up')}
							><ArrowUpIcon class="size-4" /></Button
							>
							<Button
								variant="ghost"
								size="icon"
								tooltip="Move Transformation down"
								disabled={index === app.transformations.sorted.length - 1}
								onclick={() => app.transformations.move(transformation.id, 'down')}
							><ArrowDownIcon class="size-4" /></Button
							>
							<Button
								variant="ghost"
								size="icon"
								tooltip="Edit Transformation"
								onclick={() => openEdit(transformation)}
							><PencilIcon class="size-4" /></Button
							>
							<Button
								variant="ghost"
								size="icon"
								tooltip="Delete Transformation"
								onclick={() => remove(transformation)}
							><TrashIcon class="size-4" /></Button
							>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</Card>
</main>

{#key editorGeneration}
	<TransformationEditor bind:open={editorOpen} transformation={editing} />
{/key}
