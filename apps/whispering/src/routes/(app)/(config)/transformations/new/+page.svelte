<script lang="ts">
	import { goto } from '$app/navigation';
	import { Editor } from '$lib/components/transformations-editor';
	import { Button } from '@repo/ui/button';
	import * as Card from '@repo/ui/card';
	import { rpc } from '$lib/query';
	import { generateDefaultTransformation } from '$lib/services/db';
	import { createMutation } from '@tanstack/svelte-query';

	const createTransformation = createMutation(
		rpc.db.transformations.create.options,
	);

	let transformation = $state(generateDefaultTransformation());
</script>

<Card.Root class="w-full max-w-4xl">
	<Card.Header>
		<Card.Title>Create Transformation</Card.Title>
		<Card.Description>
			Create a new transformation to transform text.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<Editor bind:transformation />
		<Card.Footer class="flex justify-end gap-2">
			<Button
				onclick={() =>
					createTransformation.mutate($state.snapshot(transformation), {
						onSuccess: () => {
							goto('/transformations');
							rpc.notify.success.execute({
								title: 'Created transformation!',
								description:
									'Your transformation has been created successfully.',
							});
						},
						onError: (error) => {
							rpc.notify.error.execute({
								title: 'Failed to create transformation!',
								description: 'Your transformation could not be created.',
								action: { type: 'more-details', error },
							});
						},
					})}
			>
				Create Transformation
			</Button>
		</Card.Footer>
	</Card.Content>
</Card.Root>
