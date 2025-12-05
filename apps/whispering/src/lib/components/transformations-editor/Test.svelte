<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Textarea } from '@epicenter/ui/textarea';
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import { rpc } from '$lib/query';
	import type { Transformation } from '$lib/services/db';
	import { createMutation } from '@tanstack/svelte-query';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import PlayIcon from '@lucide/svelte/icons/play';

	const transformInput = createMutation(rpc.transformer.transformInput.options);

	let { transformation }: { transformation: Transformation } = $props();

	let input = $state('');
	let output = $state('');
</script>

<div class="flex flex-col gap-6 overflow-y-auto h-full px-2">
	<SectionHeader.Root>
		<SectionHeader.Title>Test Transformation</SectionHeader.Title>
		<SectionHeader.Description>
			Try out your transformation with sample input
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Separator />

	<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
		<Field.Field>
			<Field.Label for="input">Input Text</Field.Label>
			<Textarea
				id="input"
				bind:value={input}
				placeholder="Enter text to transform..."
				rows={5}
			/>
		</Field.Field>

		<Field.Field>
			<Field.Label for="output">Output Text</Field.Label>
			<Textarea
				id="output"
				value={output}
				placeholder="Transformed text will appear here..."
				rows={5}
				readonly
			/>
		</Field.Field>
	</div>

	<Button
		onclick={() =>
			transformInput.mutate(
				{ input, transformation },
				{
					onSuccess: (o) => {
						if (o) {
							output = o;
						}
					},
				},
			)}
		disabled={!input.trim() || transformation.steps.length === 0}
		class="w-full"
	>
		{#if transformInput.isPending}
			<Loader2Icon class="mr-2 size-4 animate-spin" />
		{:else}
			<PlayIcon class="mr-2 size-4" />
		{/if}
		{transformInput.isPending
			? 'Running Transformation...'
			: 'Run Transformation'}
	</Button>
</div>
