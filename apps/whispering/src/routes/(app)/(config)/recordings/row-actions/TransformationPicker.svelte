<script lang="ts">
	import { goto } from '$app/navigation';
	import { nanoid } from 'nanoid/non-secure';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import TransformationPickerBody from '$lib/components/TransformationPickerBody.svelte';
	import * as Popover from '@repo/ui/popover';
	import { useCombobox } from '@repo/ui/hooks';
	import { LayersIcon } from '@lucide/svelte';
	import { rpc } from '$lib/query';
	import { createMutation } from '@tanstack/svelte-query';

	const combobox = useCombobox();

	const transformRecording = createMutation(
		rpc.transformer.transformRecording.options,
	);

	let { recordingId }: { recordingId: string } = $props();
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				tooltipContent="Run a post-processing transformation to run on your recording"
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<LayersIcon class="size-4" />
			</WhisperingButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 max-w-xl p-0">
		<TransformationPickerBody
			onSelect={(transformation) => {
				combobox.closeAndFocusTrigger();

				const toastId = nanoid();
				rpc.notify.loading.execute({
					id: toastId,
					title: '🔄 Running transformation...',
					description:
						'Applying your selected transformation to the transcribed text...',
				});

				transformRecording.mutate(
					{ recordingId, transformation },
					{
						onError: (error) => rpc.notify.error.execute(error),
						onSuccess: (transformationRun) => {
							if (transformationRun.status === 'failed') {
								rpc.notify.error.execute({
									title: '⚠️ Transformation error',
									description: transformationRun.error,
									action: {
										type: 'more-details',
										error: transformationRun.error,
									},
								});
								return;
							}

							rpc.sound.playSoundIfEnabled.execute('transformationComplete');

							rpc.delivery.deliverTransformationResult.execute({
								text: transformationRun.output,
								toastId,
							});
						},
					},
				);
			}}
			onSelectManageTransformations={() => {
				combobox.closeAndFocusTrigger();
				goto('/transformations');
			}}
			placeholder="Select transcription post-processing..."
		/>
	</Popover.Content>
</Popover.Root>
