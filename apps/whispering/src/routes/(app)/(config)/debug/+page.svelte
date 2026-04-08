<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Select from '@epicenter/ui/select';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { nanoid } from 'nanoid/non-secure';
	import {
		defineErrors,
		extractErrorMessage,
		type InferErrors,
	} from 'wellcrafted/error';
	import { tryAsync, trySync } from 'wellcrafted/result';
	import * as Y from 'yjs';
	import { workspace } from '$lib/client';

	const DebugStressTestError = defineErrors({
		GenerateFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to generate test recordings: ${extractErrorMessage(cause)}`,
			cause,
		}),
		DeleteFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to delete test recordings: ${extractErrorMessage(cause)}`,
			cause,
		}),
		RefreshFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to refresh debug metrics: ${extractErrorMessage(cause)}`,
			cause,
		}),
	});
	type DebugStressTestError = InferErrors<typeof DebugStressTestError>;

	// ── Metrics ────────────────────────────────────────────────────────────────

	function createMetrics() {
		const tableDefs = [
			{ label: 'Recordings', count: () => workspace.tables.recordings.count() },
			{
				label: 'Transformations',
				count: () => workspace.tables.transformations.count(),
			},
			{
				label: 'Transformation Steps',
				count: () => workspace.tables.transformationSteps.count(),
			},
			{
				label: 'Transformation Runs',
				count: () => workspace.tables.transformationRuns.count(),
			},
			{
				label: 'Transformation Step Runs',
				count: () => workspace.tables.transformationStepRuns.count(),
			},
		] as const;

		function snapshot() {
			return {
				ydocSize: Y.encodeStateAsUpdate(workspace.ydoc).byteLength,
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

	// ── Stress test ────────────────────────────────────────────────────────────

	type StressTestResult = {
		label: string;
		durationMs: number;
		rowCount: number;
		rowsPerSecond: number;
		sizeBefore: number;
		sizeAfter: number;
		sizeDelta: number;
	};

	function createStressTest() {
		const LOREM =
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.';

		const loremByLength = {
			short: LOREM.slice(0, 50),
			medium: LOREM,
			long: Array(10).fill(LOREM).join(' '),
		} satisfies Record<string, string>;

		let selectedCount = $state('100');
		let selectedContentLength = $state<keyof typeof loremByLength>('short');
		let lastResult = $state<StressTestResult | null>(null);
		let lastError = $state<DebugStressTestError | null>(null);

		function measure(label: string, count: number, operation: () => void) {
			const sizeBefore = Y.encodeStateAsUpdate(workspace.ydoc).byteLength;
			const start = performance.now();
			operation();
			const durationMs = performance.now() - start;
			const sizeAfter = Y.encodeStateAsUpdate(workspace.ydoc).byteLength;
			lastResult = {
				label,
				durationMs,
				rowCount: count,
				rowsPerSecond: count > 0 ? Math.round((count / durationMs) * 1000) : 0,
				sizeBefore,
				sizeAfter,
				sizeDelta: sizeAfter - sizeBefore,
			};
		}

		return {
			get selectedCount() {
				return selectedCount;
			},
			set selectedCount(v: string) {
				selectedCount = v;
			},
			get selectedContentLength() {
				return selectedContentLength;
			},
			set selectedContentLength(v: keyof typeof loremByLength) {
				selectedContentLength = v;
			},
			get lastResult() {
				return lastResult;
			},
			get lastError() {
				return lastError;
			},
			generate() {
				const count = Number(selectedCount);
				const content =
					loremByLength[selectedContentLength] ?? loremByLength.short;
				lastError = null;
				const { error } = trySync({
					try: () => {
						measure('Generated', count, () => {
							workspace.ydoc.transact(() => {
								for (let i = 0; i < count; i++) {
									const now = new Date().toISOString();
									workspace.tables.recordings.set({
										id: nanoid(),
										title: `Test Recording #${i + 1}`,
										subtitle: 'Generated for stress testing',
										timestamp: now,
										createdAt: now,
										updatedAt: now,
										transcribedText: content,
										transcriptionStatus: 'DONE',
										_v: 1,
									});
								}
							});
						});
					},
					catch: (cause) => DebugStressTestError.GenerateFailed({ cause }),
				});
				if (error) {
					lastError = error;
					return false;
				}
				return true;
			},
			deleteAll() {
				lastError = null;
				if (!confirm('Delete ALL recordings? This cannot be undone.'))
					return false;
				const { error } = trySync({
					try: () => {
						const count = workspace.tables.recordings.count();
						measure('Deleted', count, () =>
							workspace.tables.recordings.clear(),
						);
					},
					catch: (cause) => DebugStressTestError.DeleteFailed({ cause }),
				});
				if (error) {
					lastError = error;
					return false;
				}
				return true;
			},
			async generateAndRefresh() {
				if (!this.generate()) return;
				const { error } = await tryAsync({
					try: async () => {
						metrics.refresh();
					},
					catch: (cause) => DebugStressTestError.RefreshFailed({ cause }),
				});
				if (error) lastError = error;
			},
			async deleteAllAndRefresh() {
				if (!this.deleteAll()) return;
				const { error } = await tryAsync({
					try: async () => {
						metrics.refresh();
					},
					catch: (cause) => DebugStressTestError.RefreshFailed({ cause }),
				});
				if (error) lastError = error;
			},
		};
	}

	// ── Constants ──────────────────────────────────────────────────────────────

	const countOptions = [
		{ value: '100', label: '100' },
		{ value: '500', label: '500' },
		{ value: '1000', label: '1,000' },
		{ value: '5000', label: '5,000' },
		{ value: '10000', label: '10,000' },
	];

	const contentLengthOptions = [
		{ value: 'short', label: 'Short (~50 chars)' },
		{ value: 'medium', label: 'Medium (~500 chars)' },
		{ value: 'long', label: 'Long (~5,000 chars)' },
	];

	// ── Instance ──────────────────────────────────────────────────────────────

	const metrics = createMetrics();
	const stressTest = createStressTest();

	const selectedCountLabel = $derived(
		countOptions.find((o) => o.value === stressTest.selectedCount)?.label,
	);

	const selectedContentLengthLabel = $derived(
		contentLengthOptions.find(
			(o) => o.value === stressTest.selectedContentLength,
		)?.label,
	);

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
				Workspace metrics and stress testing tools. Only visible in development.
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

		<!-- Stress Test -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-2">
					<FlaskConicalIcon class="h-4 w-4 text-muted-foreground" />
					<Card.Title class="text-base font-medium">Stress Test</Card.Title>
				</div>
				<Card.Description>
					Generate mock recordings to benchmark Y.Doc performance.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<!-- Controls -->
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="space-y-1.5">
						<label for="stress-count" class="text-sm font-medium leading-none">
							Count
						</label>
						<Select.Root
							type="single"
							bind:value={() => stressTest.selectedCount,
								(v) => (stressTest.selectedCount = v)}
						>
							<Select.Trigger id="stress-count" class="w-full">
								{selectedCountLabel ?? 'Select count'}
							</Select.Trigger>
							<Select.Content>
								{#each countOptions as option}
									<Select.Item value={option.value} label={option.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>

					<div class="space-y-1.5">
						<label
							for="stress-content-length"
							class="text-sm font-medium leading-none"
						>
							Content Length
						</label>
						<Select.Root
							type="single"
							bind:value={() => stressTest.selectedContentLength,
								(v) => (stressTest.selectedContentLength = v)}
						>
							<Select.Trigger id="stress-content-length" class="w-full">
								{selectedContentLengthLabel ?? 'Select length'}
							</Select.Trigger>
							<Select.Content>
								{#each contentLengthOptions as option}
									<Select.Item value={option.value} label={option.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>

				<!-- Actions -->
				<div class="flex gap-2">
					<Button onclick={() => stressTest.generateAndRefresh()}>
						<FlaskConicalIcon class="mr-1.5 h-3.5 w-3.5" />
						Generate
					</Button>
					<Button
						variant="destructive"
						onclick={() => stressTest.deleteAllAndRefresh()}
					>
						<TrashIcon class="mr-1.5 h-3.5 w-3.5" />
						Delete All Recordings
					</Button>
				</div>

				{#if stressTest.lastError}
					<div
						class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
					>
						{stressTest.lastError.message}
					</div>
				{/if}

				<!-- Results -->
				{#if stressTest.lastResult}
					{@const result = stressTest.lastResult}
					<div class="rounded-md border bg-muted/30 p-4 space-y-2">
						<p class="text-sm font-medium">
							{result.label}
							{result.rowCount.toLocaleString()}
							rows
						</p>
						<div class="grid gap-1.5 text-sm">
							<div class="flex justify-between">
								<span class="text-muted-foreground">Duration</span>
								<span class="font-mono">{result.durationMs.toFixed(1)} ms</span>
							</div>
							<div class="flex justify-between">
								<span class="text-muted-foreground">Throughput</span>
								<span class="font-mono"
									>{result.rowsPerSecond.toLocaleString()}
									rows/s</span
								>
							</div>
							<div class="flex justify-between">
								<span class="text-muted-foreground">Size before</span>
								<span class="font-mono">{formatBytes(result.sizeBefore)}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-muted-foreground">Size after</span>
								<span class="font-mono">{formatBytes(result.sizeAfter)}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-muted-foreground">Size delta</span>
								<span class="font-mono">
									{result.sizeDelta >= 0 ? '+' : ''}
									{formatBytes(Math.abs(result.sizeDelta))}
								</span>
							</div>
						</div>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}
