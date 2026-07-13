<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Item from '@epicenter/ui/item';
	import { Label } from '@epicenter/ui/label';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Separator from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import type { RowConformance } from '@epicenter/matter-core';
	import { editorPreferences } from '$lib/editor/editor-preferences.svelte';
	import MarkdownBodyEditor from './MarkdownBodyEditor.svelte';
	import ModeledCell from './ModeledCell.svelte';

	let {
		open = $bindable(false),
		conformance,
		onSaveField,
		onSaveBody,
	}: {
		open?: boolean;
		conformance: RowConformance;
		onSaveField: (fileName: string, key: string, value: unknown) => void;
		onSaveBody: (fileName: string, body: string) => void;
	} = $props();

	const row = $derived(conformance.row);
	const cellCounts = $derived.by(() => {
		const counts = { ok: 0, invalid: 0, missingRequired: 0 };
		for (const cell of conformance.cells) {
			if (cell.state === 'OK') counts.ok++;
			else if (cell.state === 'INVALID') counts.invalid++;
			else if (cell.state === 'MISSING_REQUIRED') counts.missingRequired++;
		}
		return counts;
	});

	function formatExtraValue(value: unknown): string {
		if (typeof value !== 'object') return String(value);
		return JSON.stringify(value) ?? '';
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="grid-rows-[auto_minmax(0,1fr)] h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-7xl overflow-hidden p-0 sm:max-w-7xl"
	>
		<Dialog.Header class="gap-3 border-b px-6 py-5 pr-14 text-left">
			<div class="min-w-0 space-y-2">
				<Dialog.Title class="truncate font-mono text-xl leading-tight">
					{row.fileName}
				</Dialog.Title>
				<Dialog.Description class="sr-only">
					Edit frontmatter fields and the Markdown body for {row.fileName}.
				</Dialog.Description>
				<div class="flex flex-wrap gap-1.5">
					<Badge variant={conformance.rowValid ? 'secondary' : 'outline'}>
						{conformance.rowValid ? 'Ready' : 'Needs attention'}
					</Badge>
					<Badge variant="secondary">
						{cellCounts.ok} of {conformance.cells.length} fields filled
					</Badge>
					{#if cellCounts.missingRequired}
						<Badge
							class="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
							variant="outline"
						>
							{cellCounts.missingRequired} missing
						</Badge>
					{/if}
					{#if cellCounts.invalid}
						<Badge variant="destructive">{cellCounts.invalid} invalid</Badge>
					{/if}
					{#if conformance.extras.length}
						<Badge variant="outline">{conformance.extras.length} extra keys</Badge>
					{/if}
				</div>
			</div>
		</Dialog.Header>

		<div class="min-h-0 overflow-y-auto">
			<div class="mx-auto grid w-full max-w-6xl gap-8 px-6 py-7">
				<section class="grid gap-3">
					<SectionHeader.Root>
						<SectionHeader.Title level={3}>Frontmatter</SectionHeader.Title>
					</SectionHeader.Root>
					<div class="grid gap-2">
						{#each conformance.cells as cell (cell.field.name)}
							<Item.Root
								variant="outline"
								size="sm"
								class="gap-3 sm:flex-nowrap"
								aria-invalid={cell.state === 'INVALID' || cell.state === 'MISSING_REQUIRED'}
							>
								<Item.Content class="min-w-40 flex-none">
									<Item.Title>{cell.field.name}</Item.Title>
									<Item.Description class="uppercase tracking-wide">
										{cell.field.kind}
									</Item.Description>
								</Item.Content>
								<Item.Content class="min-w-0">
									<ModeledCell
										{cell}
										mode="detail"
										save={(value) => onSaveField(row.fileName, cell.field.name, value)}
										clear={() => onSaveField(row.fileName, cell.field.name, undefined)}
									/>
								</Item.Content>
							</Item.Root>
						{/each}
					</div>
				</section>

				{#if conformance.extras.length}
					<section class="grid gap-3">
						<SectionHeader.Root>
							<SectionHeader.Title level={3}>Extra keys</SectionHeader.Title>
						</SectionHeader.Root>
						<div class="grid gap-2">
							{#each conformance.extras as extra (extra.key)}
							<Item.Root variant="muted" size="sm" class="gap-3 sm:flex-nowrap">
								<Item.Content class="min-w-40 flex-none">
									<Item.Title class="font-mono text-xs text-muted-foreground">
										{extra.key}
									</Item.Title>
								</Item.Content>
								<Item.Content>
									<code class="min-w-0 truncate text-xs">
										{formatExtraValue(extra.value)}
									</code>
									</Item.Content>
								</Item.Root>
							{/each}
						</div>
					</section>
				{/if}

				<Separator.Root />

				<section class="grid gap-3">
					<div class="flex items-center justify-between gap-3">
						<SectionHeader.Root>
							<SectionHeader.Title level={3}>Body</SectionHeader.Title>
						</SectionHeader.Root>
						<div class="flex items-center gap-2">
							<Label for="matter-vim-mode" class="text-xs text-muted-foreground">Vim</Label>
							<Switch
								id="matter-vim-mode"
								size="sm"
								checked={editorPreferences.vimEnabled}
								onCheckedChange={(checked) => editorPreferences.setVimEnabled(checked)}
							/>
						</div>
					</div>
					{#key row.fileName}
						<!-- Keep teardown saves pointed at this keyed editor instance's row. -->
						{@const fileName = row.fileName}
						<MarkdownBodyEditor
							body={row.body}
							vimEnabled={editorPreferences.vimEnabled}
							onCommit={(body) => onSaveBody(fileName, body)}
						/>
					{/key}
				</section>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
