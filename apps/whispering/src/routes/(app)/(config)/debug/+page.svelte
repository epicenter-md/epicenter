<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import * as Y from 'yjs';
	import { whispering } from '#platform/whispering';

	// ── Metrics ────────────────────────────────────────────────────────────────

	function createMetrics() {
		const tableDefs = [
			{
				label: 'Recordings',
				count: () => whispering.tables.recordings.storedCount(),
			},
			{
				label: 'Recipes',
				count: () => whispering.tables.recipes.storedCount(),
			},
		] as const;

		function snapshot() {
			return {
				ydocSize: Y.encodeStateAsUpdate(whispering.ydoc).byteLength,
				tables: tableDefs.map((t) => ({ label: t.label, count: t.count() })),
			};
		}

		let current = $state(snapshot());

		return {
			get current() {
				return current;
			},
			refresh() {
				current = snapshot();
			},
		};
	}

	// ── Instance ──────────────────────────────────────────────────────────────

	const metrics = createMetrics();

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}
</script>

{#if import.meta.env.DEV}
	<div class="space-y-8">
		<!-- Page Header -->
		<SectionHeader.Root>
			<div class="flex items-center gap-3">
				<SectionHeader.Title level={3} class="text-xl tracking-tight">
					Debug
				</SectionHeader.Title>
			</div>
			<SectionHeader.Description class="max-w-2xl">
				Workspace metrics. Only visible in development.
			</SectionHeader.Description>
		</SectionHeader.Root>

		<!-- Workspace Metrics -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<DatabaseIcon class="h-4 w-4 text-muted-foreground" />
						<Card.Title class="text-base font-medium"
							>Workspace Metrics</Card.Title
						>
					</div>
					<Button variant="outline" size="sm" onclick={() => metrics.refresh()}>
						<RefreshCwIcon class="mr-1.5 h-3.5 w-3.5" />
						Refresh
					</Button>
				</div>
			</Card.Header>
			<Card.Content>
				<div class="space-y-4">
					<!-- Y.Doc Size -->
					<div class="flex items-center justify-between rounded-md border p-3">
						<span class="text-sm text-muted-foreground"
							>Y.Doc encoded size</span
						>
						<span class="font-mono text-sm font-medium">
							{formatBytes(metrics.current.ydocSize)}
							<span class="text-muted-foreground"
								>({metrics.current.ydocSize.toLocaleString()}
								bytes)</span
							>
						</span>
					</div>

					<!-- Table Row Counts -->
					<div class="grid gap-2">
						{#each metrics.current.tables as table}
							<div
								class="flex items-center justify-between rounded-md border px-3 py-2"
							>
								<span class="text-sm text-muted-foreground">{table.label}</span>
								<span class="font-mono text-sm font-medium"
									>{table.count.toLocaleString()}</span
								>
							</div>
						{/each}
					</div>
				</div>
			</Card.Content>
		</Card.Root>
	</div>
{/if}
