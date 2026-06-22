<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import TranscriptionRuntimeConfig from '$lib/components/settings/TranscriptionRuntimeConfig.svelte';
	import TranscriptionServiceSelect from '$lib/components/settings/TranscriptionServiceSelect.svelte';
	import { settings } from '$lib/state/settings.svelte';
</script>

<svelte:head> <title>Transcription Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Transcription</Field.Legend>
	<Field.Description>
		Choose where transcription runs, which model to use, and how language
		hints work.
	</Field.Description>
	<Field.Separator />
	<TranscriptionServiceSelect
		bind:selected={() => settings.get('transcription.service'),
			(selected) => settings.set('transcription.service', selected)}
	/>
	<TranscriptionRuntimeConfig />
</Field.Set>
