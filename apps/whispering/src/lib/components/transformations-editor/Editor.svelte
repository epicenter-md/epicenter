<script lang="ts">
	import * as Resizable from '@repo/ui/resizable';
	import { rpc } from '$lib/query';
	import type { Transformation } from '$lib/services/db';
	import { createQuery } from '@tanstack/svelte-query';
	import Configuration from './Configuration.svelte';
	import Runs from './Runs.svelte';
	import Test from './Test.svelte';

	let { transformation = $bindable() }: { transformation: Transformation } =
		$props();

	const transformationRunsByTransformationIdQuery = createQuery(
		rpc.db.runs.getByTransformationId(() => transformation.id).options,
	);
</script>

<Resizable.PaneGroup direction="horizontal">
	<Resizable.Pane>
		<Configuration bind:transformation />
	</Resizable.Pane>
	<Resizable.Handle withHandle />
	<Resizable.Pane>
		<Resizable.PaneGroup direction="vertical">
			<Resizable.Pane>
				<Test {transformation} />
			</Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane>
				{#if transformationRunsByTransformationIdQuery.isPending}
					<div class="text-muted-foreground text-sm p-4">Loading runs...</div>
				{:else if transformationRunsByTransformationIdQuery.error}
					<div class="text-destructive text-sm p-4">
						Error loading transformation runs: {transformationRunsByTransformationIdQuery
							.error.message}
					</div>
				{:else if transformationRunsByTransformationIdQuery.data}
					<Runs runs={transformationRunsByTransformationIdQuery.data} />
				{/if}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</Resizable.Pane>
</Resizable.PaneGroup>
