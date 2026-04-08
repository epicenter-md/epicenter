<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import type { Snippet } from 'svelte';
	import { migrationDialog } from './migration-dialog.svelte';
	import {
		MOCK_RECORDING_COUNT,
		MOCK_TRANSFORMATION_COUNT,
	} from './migration-test-data';

	let { trigger }: { trigger?: Snippet<[{ props: Record<string, unknown> }]> } =
		$props();

	let logsContainer = $state<HTMLDivElement | null>(null);

	// Auto-scroll logs to bottom
	$effect(() => {
		if (logsContainer && migrationDialog.logs.length > 0) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});
</script>

<Dialog.Root bind:open={migrationDialog.isOpen}>
	{#if trigger}
		<Dialog.Trigger>
			{#snippet child({ props })}
				{@render trigger({ props })}
			{/snippet}
		</Dialog.Trigger>
	{/if}
	<Dialog.Content class="max-h-[90vh] max-w-2xl overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>Database Migration</Dialog.Title>
			<Dialog.Description>
				Migrate your recordings and transformations to the new workspace format.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			{#if migrationDialog.isPending}
				<Button
					onclick={migrationDialog.startWorkspaceMigration}
					disabled={migrationDialog.phase === 'running'}
					class="w-full"
				>
					{migrationDialog.phase === 'running' ? 'Migrating…' : migrationDialog.hasFailedAttempt ? 'Retry Migration' : 'Start Migration'}
				</Button>
			{:else}
				<Field.Description>Migration is already complete.</Field.Description>
			{/if}

			{#if migrationDialog.logs.length > 0}
				<Field.Set>
					<Field.Legend variant="label">Progress</Field.Legend>
					<div
						bind:this={logsContainer}
						class="max-h-48 overflow-y-auto rounded-lg border bg-muted p-3 font-mono text-xs"
					>
						{#each migrationDialog.logs as log}
							<div class="mb-1">{log}</div>
						{/each}
					</div>
				</Field.Set>
			{/if}

			{#if migrationDialog.migrationResult}
				{@const r = migrationDialog.migrationResult}
				<Field.Set class="rounded-lg border p-4">
					<Field.Legend variant="label">Results</Field.Legend>
					<div class="space-y-1">
						<Field.Description>
							Recordings: {r.recordings.migrated} migrated,
							{r.recordings.skipped}
							skipped, {r.recordings.failed} failed (of {r.recordings.total})
						</Field.Description>
						<Field.Description>
							Transformations: {r.transformations.migrated} migrated,
							{r.transformations.skipped}
							skipped, {r.transformations.failed} failed (of
							{r.transformations.total})
						</Field.Description>
						<Field.Description>
							Steps: {r.steps.migrated} migrated, {r.steps.skipped} skipped,
							{r.steps.failed}
							failed (of {r.steps.total})
						</Field.Description>
					</div>
				</Field.Set>
			{/if}

			{#if import.meta.env.DEV}
				<Field.Set class="rounded-lg border border-dashed p-4">
					<Field.Legend>Dev Tools</Field.Legend>
					<Field.Group>
						<Field.Set>
							<Field.Legend variant="label">Seed & Clear</Field.Legend>
							<div class="flex flex-wrap gap-2">
								<Button
									onclick={migrationDialog.seedIndexedDB}
									disabled={migrationDialog.isDevBusy}
									variant="outline"
									size="sm"
								>
									{migrationDialog.isSeeding
										? 'Seeding\u2026'
										: `Seed ${MOCK_RECORDING_COUNT} Recordings + ${MOCK_TRANSFORMATION_COUNT} Transformations`}
								</Button>
								<Button
									onclick={migrationDialog.clearIndexedDB}
									disabled={migrationDialog.isDevBusy}
									variant="outline"
									size="sm"
								>
									{migrationDialog.isClearing ? 'Clearing\u2026' : 'Clear IndexedDB'}
								</Button>
							</div>
						</Field.Set>
						<Field.Separator />
						<Field.Set>
							<Field.Legend variant="label">Reset</Field.Legend>
							<Field.Description>
								Clears workspace tables and resets localStorage\u2014re-enables
								the migration button.
							</Field.Description>
							<Button
								onclick={migrationDialog.resetMigration}
								disabled={migrationDialog.isDevBusy}
								variant="outline"
								size="sm"
							>
								{migrationDialog.isResetting
									? 'Resetting\u2026'
									: 'Reset Migration State'}
							</Button>
						</Field.Set>
					</Field.Group>
				</Field.Set>
			{/if}
		</div>

		<Dialog.Footer>
			<Button
				onclick={() => (migrationDialog.isOpen = false)}
				variant="outline"
			>
				Close
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
