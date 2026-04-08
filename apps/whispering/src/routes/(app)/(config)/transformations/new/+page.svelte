<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { goto } from '$app/navigation';
	import { Editor } from '$lib/components/transformations-editor';
	import { rpc } from '$lib/query';
	import { type TransformationStep } from '$lib/state/transformation-steps.svelte';
	import {
		generateDefaultTransformation,
		saveTransformationWithSteps,
	} from '$lib/state/transformations.svelte';

	let transformation = $state(generateDefaultTransformation());
	let steps = $state<TransformationStep[]>([]);
</script>

<Card.Root class="w-full max-w-4xl">
	<Card.Header>
		<Card.Title>Create Transformation</Card.Title>
		<Card.Description>
			Create a new transformation to transform text.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<Editor bind:transformation bind:steps />
		<Card.Footer class="flex justify-end gap-2">
			<Button
				onclick={() => {
					saveTransformationWithSteps(
						$state.snapshot(transformation),
						$state.snapshot(steps),
					);
					goto('/transformations');
					rpc.notify.success({
						title: 'Created transformation!',
						description: 'Your transformation has been created successfully.',
					});
				}}
			>
				Create Transformation
			</Button>
		</Card.Footer>
	</Card.Content>
</Card.Root>
