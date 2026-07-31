<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { WHISPERING_APPLICATION } from '../applications.ts';
	import { createLaunch } from './launch.svelte.ts';
	import LocalModelAdministration from './LocalModelAdministration.svelte';
	import { localModels } from './local-models.svelte';

	/**
	 * Host-level administration (ADR-0189). Today that is the one active local
	 * transcription model (ADR-0180), which lives here rather than in the shell
	 * header: choosing what every application on this device transcribes with is
	 * a settings act, not a conversation control.
	 *
	 * The choice names files and an accelerator on this machine, so a browser or
	 * remote Home says where it lives instead of offering controls that would
	 * reach the wrong device.
	 */

	const launcher = createLaunch();

	/**
	 * Whether local transcription can actually run now: a model is chosen and its
	 * files are on this device.
	 *
	 * This is the condition for the shortcut below, and it is deliberately a
	 * statement about the host rather than about who is reading it. Nothing
	 * records that the user arrived from Whispering (ADR-0189), so the shortcut
	 * is offered on the same terms to someone who set a model up on their own.
	 */
	const isLocalTranscriptionReady = $derived(
		localModels.active !== null && localModels.active.installed,
	);
</script>

{#if localModels.available}
	<div class="grid gap-3 p-3">
		<LocalModelAdministration />

		{#if isLocalTranscriptionReady}
			<!-- The ordinary launch action, not a return path: it states what is
			     true of the host, and the user chooses. Same row shape as the Apps
			     pane, because it is the same act. -->
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Description>
						Local transcription is ready on this device.
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Button
						variant="outline"
						size="sm"
						onclick={() => void launcher.launch(WHISPERING_APPLICATION)}
					>
						Open {WHISPERING_APPLICATION.title}
					</Button>
				</Item.Actions>
			</Item.Root>
		{/if}

		{#if launcher.failure}
			<Alert.Root variant="destructive">
				<Alert.Title>Could not open</Alert.Title>
				<Alert.Description>{launcher.failure}</Alert.Description>
			</Alert.Root>
		{/if}
	</div>
{:else}
	<Empty.Root class="h-full border-0">
		<Empty.Header>
			<Empty.Title>Settings live on the desktop</Empty.Title>
			<Empty.Description>
				The active local transcription model names files and an accelerator on
				the machine running Epicenter, so it is administered there.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}
