<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
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
</script>

{#if localModels.available}
	<div class="p-3">
		<LocalModelAdministration />
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
